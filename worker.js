/**
 * =================================================================================
 * 项目: stockai-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Chimera Synthesis - StockAI)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-06
 *
 * [核心特性]
 * 1. [双模适配] 同时支持流式(SSE)和非流式(JSON)响应，完美适配沉浸式翻译插件。
 * 2. [协议清洗] 将 StockAI 的自定义事件流实时转换为标准 OpenAI 格式。
 * 3. [匿名伪装] 内置浏览器指纹，无需登录即可使用。
 * 4. [开发者驾驶舱] 集成全中文调试界面，实时监控请求与响应。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "stockai-2api",
  PROJECT_VERSION: "1.0.0",

  // 硬编码配置 (按需替换)
  API_KEY: "sk-stockai-proxy-demo",
  DEFAULT_MODEL: "openai/gpt-4o-mini",

  // 上游服务配置
  UPSTREAM_ORIGIN: "https://free.stockai.trade",
  UPSTREAM_API_URL: "https://free.stockai.trade/api/chat",

  // 伪装指纹 (基于 Chrome 142)
  HEADERS: {
    "authority": "free.stockai.trade",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://free.stockai.trade",
    "referer": "https://free.stockai.trade/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '\"Chromium\";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '\"Windows\"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },

  // 模型列表 (从源码和抓包中提取)
  MODELS: [
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash",
    "stockai/news",
    "deepseek/deepseek-chat-v3.1",
    "meta/llama-4-scout",
    "moonshotai/kimi-k2",
    "z-ai/glm-4.6",
    "mistral/mistral-small",
    "qwen/qwen3-coder"
  ]
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = CONFIG.API_KEY;
    request.ctx = { apiKey };

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 路由分发
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);

    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  // 鉴权
  if (!verifyAuth(request)) {
    return createErrorResponse('Unauthorized', 401, 'auth_error');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  }

  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }

  return createErrorResponse('Not Found', 404, 'not_found');
}

// 处理模型列表
function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(id => ({
      id: id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'stockai-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// 处理聊天请求 (核心逻辑)
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const messages = body.messages || [];
    const stream = body.stream !== false; // 默认为 true，除非显式设为 false
    const isWebUI = body.is_web_ui === true;

    // 1. 转换消息格式 (OpenAI -> StockAI)
    // StockAI 格式: { parts: [{type: "text", text: "..."}], role: "user", id: "..." }
    const convertedMessages = messages.map(msg => ({
      parts: [{ type: "text", text: msg.content }],
      id: generateRandomId(16),
      role: msg.role
    }));

    // 2. 构造上游 Payload
    const payload = {
      model: model,
      webSearch: false, // 暂不支持联网，保持简单
      id: generateRandomId(16), // 会话ID
      messages: convertedMessages,
      trigger: "submit-message"
    };

    // 3. 发送请求
    const response = await fetch(CONFIG.UPSTREAM_API_URL, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`上游服务错误 (${response.status}): ${errText}`);
    }

    // 4. 处理响应
    // StockAI 始终返回 SSE 流。
    // 如果客户端请求 stream=true，我们做实时转换。
    // 如果客户端请求 stream=false (如沉浸式翻译)，我们需要消费整个流并拼接结果。

    if (stream) {
      return handleStreamResponse(response, model, requestId, isWebUI);
    } else {
      return handleNonStreamResponse(response, model, requestId);
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// 处理流式响应 (SSE -> SSE)
function handleStreamResponse(upstreamResponse, model, requestId, isWebUI) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    try {
      const reader = upstreamResponse.body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === '[DONE]') continue;

            try {
              const data = JSON.parse(dataStr);

              // StockAI 的 delta 在 data.delta 中，且类型为 text-delta
              if (data.type === 'text-delta' && data.delta) {
                const chunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              // 处理结束
              else if (data.type === 'finish') {
                 // Do nothing, wait for loop end or explicit stop
              }
            } catch (e) { }
          }
        }
      }

      // 发送结束标记
      const endChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));

    } catch (e) {
      const errChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: { content: `\n\n[Error: ${e.message}]` }, finish_reason: "error" }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
  });
}

// 处理非流式响应 (SSE -> JSON)
// 适配沉浸式翻译等不支持流的插件
async function handleNonStreamResponse(upstreamResponse, model, requestId) {
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'text-delta' && data.delta) {
              fullText += data.delta;
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    throw new Error(`Stream buffering failed: ${e.message}`);
  }

  const response = {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: fullText },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };

  return new Response(JSON.stringify(response), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// --- 辅助函数 ---

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (!key) return false;
  return auth === `Bearer ${key}`;
}

function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${CONFIG.PROJECT_NAME} · Cloudflare Worker</title>
  <style>
    :root {
      --bg: #0b1021;
      --card: #11172e;
      --panel: #0f1428;
      --border: #1f2a48;
      --text: #e8ecff;
      --muted: #9fb1ff;
      --primary: #ffd166;
      --accent: #7bdff2;
      --danger: #ff6b6b;
      --success: #1dd1a1;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Inter', 'Segoe UI', system-ui, -apple-system; background: radial-gradient(circle at 10% 20%, rgba(123,223,242,0.12), transparent 25%), radial-gradient(circle at 90% 10%, rgba(255,209,102,0.1), transparent 25%), var(--bg); color: var(--text); min-height: 100vh; }
    a { color: var(--accent); text-decoration: none; }
    .shell { max-width: 1200px; margin: 0 auto; padding: 28px 18px 38px; display: flex; flex-direction: column; gap: 18px; }
    header { background: linear-gradient(135deg, rgba(123,223,242,0.08), rgba(255,209,102,0.08)); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; display: flex; justify-content: space-between; gap: 16px; align-items: center; box-shadow: 0 18px 60px rgba(0,0,0,0.35); }
    .title { font-size: 22px; font-weight: 800; display: flex; flex-direction: column; gap: 4px; }
    .title small { color: var(--muted); font-weight: 500; }
    .badge { background: rgba(255,209,102,0.16); color: var(--primary); padding: 8px 12px; border-radius: 10px; font-weight: 700; border: 1px solid rgba(255,209,102,0.3); }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 16px 18px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
    .card h3 { margin: 0 0 10px; font-size: 16px; letter-spacing: 0.2px; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--panel); border: 1px dashed var(--border); border-radius: 10px; font-family: 'JetBrains Mono', monospace; font-size: 13px; cursor: pointer; }
    .pill:hover { border-color: var(--accent); color: var(--accent); }
    .list { margin: 0; padding-left: 18px; color: var(--muted); line-height: 1.55; }
    .section-title { font-size: 18px; margin: 4px 0 10px; display: flex; align-items: center; gap: 8px; }
    .endpoint { display: flex; align-items: center; gap: 10px; padding: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
    .method { padding: 4px 8px; border-radius: 8px; font-weight: 700; }
    .method.post { background: rgba(123,223,242,0.16); color: var(--accent); border: 1px solid rgba(123,223,242,0.36); }
    .method.get { background: rgba(29,209,161,0.16); color: var(--success); border: 1px solid rgba(29,209,161,0.36); }
    .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
    .panel h4 { margin: 0 0 12px; font-size: 16px; }
    label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 13px; }
    input, select, textarea, button { width: 100%; border-radius: 10px; border: 1px solid var(--border); background: #0c1224; color: var(--text); padding: 10px 12px; font-size: 14px; }
    textarea { min-height: 110px; resize: vertical; }
    button { margin-top: 6px; background: linear-gradient(135deg, var(--accent), var(--primary)); border: none; color: #0c1224; font-weight: 800; letter-spacing: 0.4px; cursor: pointer; box-shadow: 0 12px 30px rgba(0,0,0,0.35); }
    button:disabled { filter: grayscale(0.5); opacity: 0.7; cursor: not-allowed; }
    .status { margin-top: 8px; font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 8px; }
    pre { background: #080c1a; border: 1px solid var(--border); border-radius: 12px; padding: 14px; color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 13px; min-height: 120px; white-space: pre-wrap; word-break: break-word; }
    footer { text-align: center; color: var(--muted); font-size: 12px; padding: 10px 0 4px; }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="title">
        <div>🛰️ ${CONFIG.PROJECT_NAME} · Cloudflare Worker</div>
        <small>All-in-one Serverless Proxy · 极致体验 · 自动适配当前域名</small>
      </div>
      <div class="badge">v${CONFIG.PROJECT_VERSION} · 单文件</div>
    </header>

    <section>
      <div class="section-title">📋 即用信息 (Ready-to-Use Info)</div>
      <div class="grid">
        <div class="card">
          <h3>API 地址</h3>
          <div class="pill" onclick="copyText('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>
        <div class="card">
          <h3>API 密钥</h3>
          <div class="pill" onclick="copyText('${CONFIG.API_KEY}')">${CONFIG.API_KEY}</div>
        </div>
        <div class="card">
          <h3>默认模型</h3>
          <div class="pill" onclick="copyText('${CONFIG.DEFAULT_MODEL}')">${CONFIG.DEFAULT_MODEL}</div>
        </div>
      </div>
    </section>

    <section>
      <div class="section-title">🔌 完整接口路径 (Full API Endpoints)</div>
      <div class="grid">
        <div class="card">
          <div class="endpoint"><span class="method post">POST</span><span>${origin}/v1/chat/completions</span></div>
          <div class="endpoint" style="margin-top:8px;"><span class="method get">GET</span><span>${origin}/v1/models</span></div>
        </div>
        <div class="card">
          <h3>可用模型</h3>
          <ul class="list">
            ${CONFIG.MODELS.map(m => `<li>${m}</li>`).join('')}
          </ul>
        </div>
      </div>
    </section>

    <section>
      <div class="section-title">🛠️ 开发者信息 (Developer Info)</div>
      <div class="grid">
        <div class="card">
          <h3>上游接口 (Upstream API)</h3>
          <div class="pill" onclick="copyText('${CONFIG.UPSTREAM_API_URL}')">${CONFIG.UPSTREAM_API_URL}</div>
        </div>
        <div class="card">
          <h3>项目模式 (Project Mode)</h3>
          <div class="pill">伪流式代理 (Pseudo-Stream Proxy)</div>
        </div>
        <div class="card">
          <h3>请求指纹</h3>
          <div class="pill">Chrome 142 / Same-Origin CORS / SSE → OpenAI</div>
        </div>
      </div>
    </section>

    <section>
      <div class="section-title">🚀 在线 API 测试 (Live API Tester)</div>
      <div class="grid">
        <div class="panel">
          <h4>请求参数</h4>
          <label>API 地址</label>
          <input id="api-url" readonly value="${origin}/v1/chat/completions" />
          <label>API 密钥 (自动填充)</label>
          <input id="api-key" readonly value="${CONFIG.API_KEY}" />
          <label>模型</label>
          <select id="model">${CONFIG.MODELS.map(m => `<option value="${m}" ${m === CONFIG.DEFAULT_MODEL ? 'selected' : ''}>${m}</option>`).join('')}</select>
          <label>提示词 (Prompt)</label>
          <textarea id="prompt">你好，请用 2 句话介绍这个 Worker 的能力。</textarea>
          <label style="display:flex; align-items:center; gap:10px;">
            <input type="checkbox" id="stream" checked style="width:auto; height:auto;"> 以 SSE 流式返回
          </label>
          <button id="btn-send" onclick="sendTest()">发送</button>
          <div class="status" id="status">⚡ 就绪 · 自动使用当前域名与内置密钥</div>
        </div>
        <div class="panel">
          <h4>实时返回</h4>
          <pre id="result">等待请求...</pre>
        </div>
      </div>
    </section>

    <footer>Made with ☁️ + ⚡ · 自动适配 Cloudflare Workers · 纯前端内联</footer>
  </div>

  <script>
    const HARDCODED_KEY = '${CONFIG.API_KEY}';
    const BASE_URL = window.location.origin;

    function copyText(text) {
      navigator.clipboard?.writeText(text).then(() => {
        const status = document.getElementById('status');
        status.textContent = '📎 已复制: ' + text;
        setTimeout(() => status.textContent = '⚡ 就绪 · 自动使用当前域名与内置密钥', 1500);
      });
    }

    async function sendTest() {
      const prompt = document.getElementById('prompt').value.trim();
      const model = document.getElementById('model').value;
      const stream = document.getElementById('stream').checked;
      const result = document.getElementById('result');
      const status = document.getElementById('status');
      const btn = document.getElementById('btn-send');

      if (!prompt) {
        result.textContent = '⚠️ 请先输入提示词';
        return;
      }

      const endpoint = BASE_URL + '/v1/chat/completions';
      status.textContent = '🧠 正在思考...';
      result.textContent = '';
      btn.disabled = true;

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + HARDCODED_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream,
            is_web_ui: true
          })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
          throw new Error(err.error?.message || '请求失败');
        }

        if (stream) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let full = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const dataStr = line.slice(6);
              if (dataStr === '[DONE]') continue;
              try {
                const json = JSON.parse(dataStr);
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) {
                  full += delta;
                  result.textContent = full;
                }
              } catch (err) { }
            }
          }
          if (!full) result.textContent = 'ℹ️ 流式通道已完成，但未返回内容';
        } else {
          const data = await res.json();
          result.textContent = data.choices?.[0]?.message?.content || JSON.stringify(data, null, 2);
        }

        status.textContent = '✅ 已完成 · SSE 转换 → OpenAI 兼容';
      } catch (err) {
        status.textContent = '❌ 错误';
        result.textContent = 'Error: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
