import * as provider from './provider'
import * as gemini from './gemini'
import * as openai from './openai'

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            return await handle(request)
        } catch (error) {
            console.error(error)
            return new Response('Internal server error', { status: 500 })
        }
    }
} satisfies ExportedHandler<Env>

async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 })
    }

    const { typeParam, baseUrl, err: pathErr } = parsePath(new URL(request.url))
    if (pathErr) {
        return pathErr
    }

    const { apiKey, mutatedHeaders, err: apiKeyErr } = getApiKey(request.headers)
    if (apiKeyErr) {
        return apiKeyErr
    }

    if (!apiKey || !typeParam || !baseUrl) {
        return new Response('Internal server error, missing params', { status: 500 })
    }

    let provider: provider.Provider
    switch (typeParam) {
        case 'gemini':
            provider = new gemini.impl()
            break
        case 'openai':
            provider = new openai.impl()
            break
        default:
            return new Response('Unsupported type', { status: 400 })
    }

    const providerRequest = await provider.convertToProviderRequest(
        new Request(request, { headers: mutatedHeaders }),
        baseUrl,
        apiKey
    )
    const providerResponse = await fetch(providerRequest)
// ------------------ 修复 Claude Code usage 解析崩溃 ------------------
    let claudeBody: any;
    try {
      claudeBody = await providerResponse.clone().json();  // clone 避免 body 被消费
    } catch (e) {
      // 如果不是 JSON，直接原样返回
      return providerResponse;
    }

    // 强制把 usage 改成 Claude 风格（关键！）
    if (claudeBody && claudeBody.usage) {
      claudeBody.usage = {
        input_tokens: claudeBody.usage.prompt_tokens ?? claudeBody.usage.input_tokens ?? 0,
        output_tokens: claudeBody.usage.completion_tokens ?? claudeBody.usage.output_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      };
    } else if (claudeBody) {
      // 如果 usage 完全缺失，补一个默认值（防止 undefined 崩溃）
      claudeBody.usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      };
    }

    // 用修改后的 body 创建新 Response（保留原 status 和 headers）
    const modifiedResponse = new Response(JSON.stringify(claudeBody), {
      status: providerResponse.status,
      statusText: providerResponse.statusText,
      headers: providerResponse.headers
    });

    // ------------------ 修复结束 ------------------

    // 原来的返回改成返回 modifiedResponse
    return modifiedResponse;
}

function parsePath(url: URL): { typeParam?: string; baseUrl?: string; err?: Response } {
    const pathParts = url.pathname.split('/').filter(part => part !== '')
    if (pathParts.length < 3) {
        return {
            err: new Response('Invalid path format. Expected: /{type}/{provider_url}/v1/messages', { status: 400 })
        }
    }
    const lastTwoParts = pathParts.slice(-2)
    if (lastTwoParts[0] !== 'v1' || lastTwoParts[1] !== 'messages') {
        return { err: new Response('Path must end with /v1/messages', { status: 404 }) }
    }

    const typeParam = pathParts[0]
    const providerUrlParts = pathParts.slice(1, -2)

    // [..., 'https:', ...] ==> [..., 'https:/', ...]
    if (pathParts[1] && pathParts[1].startsWith('http')) {
        pathParts[1] = pathParts[1] + '/'
    }

    const baseUrl = providerUrlParts.join('/')
    if (!typeParam || !baseUrl) {
        return { err: new Response('Missing type or provider_url in path', { status: 400 }) }
    }

    return { typeParam, baseUrl }
}

function getApiKey(headers: Headers): { apiKey?: string; mutatedHeaders?: Headers; err?: Response } {
    const mutatedHeaders = new Headers(headers)
    let apiKey = headers.get('x-api-key')
    if (apiKey) {
        mutatedHeaders.delete('x-api-key')
    } else {
        apiKey = mutatedHeaders.get('authorization')
        if (apiKey) {
            mutatedHeaders.delete('authorization')
        }
    }

    if (!apiKey) {
        return { err: new Response('Missing x-api-key or authorization header', { status: 401 }) }
    }

    return { apiKey, mutatedHeaders }
}
