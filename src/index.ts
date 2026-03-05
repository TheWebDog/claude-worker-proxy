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
    
    console.log('NVIDIA raw response headers:', Object.fromEntries(providerResponse.headers.entries()));
    
    // 先让原有转换函数处理（支持流式转换 OpenAI → Claude 格式）
    let claudeResponse = await provider.convertToClaudeResponse(providerResponse);

    console.log('After convertToClaudeResponse headers:', Object.fromEntries(claudeResponse.headers.entries()));

    // 判断是否流式（text/event-stream 是 OpenAI/Claude 流式标准）
    const contentType = claudeResponse.headers.get('content-type') || '';
    const isStream = contentType.includes('text/event-stream');

    if (!isStream) {
      // 非流式：直接读 body 修改 usage（简单）
      let body: any;
      try {
        body = await claudeResponse.clone().json();
      } catch (e) {
        return claudeResponse;
      }

      if (body?.usage) {
        body.usage = {
          input_tokens: body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0,
          output_tokens: body.usage.completion_tokens ?? body.usage.output_tokens ?? 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        };
      } else if (body) {
        body.usage = {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        };
      }

      return new Response(JSON.stringify(body), {
        status: claudeResponse.status,
        statusText: claudeResponse.statusText,
        headers: claudeResponse.headers
      });
    }

    // 流式：用 TransformStream 拦截 chunk，只改 usage chunk
    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        // chunk 是 Uint8Array，转字符串
        const text = new TextDecoder().decode(chunk);

        console.log('SSE chunk received:', text);  // 打印每个原始 chunk
          
        const lines = text.split('\n\n');  // SSE 以 \n\n 分行

        for (const line of lines) {
          if (!line.trim()) continue;

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              // [DONE] 原样输出
              controller.enqueue(new TextEncoder().encode(line + '\n\n'));
              continue;
            }

            try {
              const json = JSON.parse(data);
              if (json.usage) {
                // 这是 usage chunk！改成 Claude 风格
                const newUsage = {
                  input_tokens: json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0,
                  output_tokens: json.usage.completion_tokens ?? json.usage.output_tokens ?? 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0
                };
                const newJson = { ...json, usage: newUsage };
                const newData = 'data: ' + JSON.stringify(newJson);
                controller.enqueue(new TextEncoder().encode(newData + '\n\n'));
                continue;
              }
            } catch (e) {
              // 解析失败，原样输出
            }
          }

          // 非 usage chunk，原样输出
          controller.enqueue(new TextEncoder().encode(line + '\n\n'));
        }
      }
    });

    // 返回新的 Response，body 是 transformStream 的 readable
    return new Response(claudeResponse.body.pipeThrough(transformStream), {
      status: claudeResponse.status,
      statusText: claudeResponse.statusText,
      headers: claudeResponse.headers
    });

    
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
