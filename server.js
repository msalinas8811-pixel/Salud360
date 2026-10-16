import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map();

function send(res, status, body, origin='*') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw='';
    req.on('data', chunk => { raw += chunk; if (raw.length > 40_000) { reject(new Error('Payload demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 1200) }));
}
function safeContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const cap = (arr, n) => Array.isArray(arr) ? arr.slice(-n).map(row => {
    const out = {};
    for (const k of ['date','time','value','glucose','ls','ld','rs','rd','ml','dose','name','type','reason','nextDate']) {
      if (row && row[k] !== undefined && ['string','number'].includes(typeof row[k])) out[k] = String(row[k]).slice(0,120);
    }
    return out;
  }) : [];
  return {
    bloodPressure: cap(ctx.bloodPressure, 20), glucose: cap(ctx.glucose, 20),
    pulse: cap(ctx.pulse, 20), weight: cap(ctx.weight, 20), waterLogs: cap(ctx.waterLogs, 30),
    medications: cap(ctx.medications, 20), visits: cap(ctx.visits, 10)
  };
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGIN === '*' ? '*' : (origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN);
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods':'GET, POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type', 'Vary':'Origin'}); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, {ok:true, service:'SaludPlus AI', configured:Boolean(API_KEY)}, corsOrigin);
  if (req.method !== 'POST' || url.pathname !== '/api/chat') return send(res, 404, {error:'Ruta no encontrada.'}, corsOrigin);
  if (ALLOWED_ORIGIN !== '*' && origin && origin !== ALLOWED_ORIGIN) return send(res, 403, {error:'Origen no autorizado.'}, corsOrigin);
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now(); const recent = (hits.get(ip) || []).filter(t => now-t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return send(res, 429, {error:'Se alcanzó el límite temporal de consultas. Espera un minuto e inténtalo de nuevo.'}, corsOrigin);
  recent.push(now); hits.set(ip, recent);
  if (!API_KEY) return send(res, 503, {error:'El servidor aún no tiene configurada la clave del proveedor de IA.'}, corsOrigin);
  try {
    const body = await readJson(req);
    const question = String(body.question || '').trim().slice(0,1200);
    const mode = body.mode === 'personal' ? 'personal' : 'general';
    if (!question) return send(res, 400, {error:'Escribe una pregunta.'}, corsOrigin);
    const context = mode === 'personal' ? safeContext(body.healthContext) : null;
    const instructions = `Eres un asistente informativo de salud de SaludPlus. Responde en español claro y prudente. No diagnostiques, no prescribas ni indiques iniciar, suspender o cambiar dosis de medicamentos. Explica incertidumbre, recomienda consultar a un profesional cuando corresponda y dirige a servicios de emergencia locales ante señales potencialmente graves. No afirmes que has revisado datos que no recibiste. No reemplazas una evaluación médica. Si la pregunta requiere información que no tienes, dilo. ${mode === 'personal' ? 'Modo personalizado: puedes comentar únicamente los registros estructurados suministrados por el usuario; distingue datos de interpretaciones y no infieras diagnósticos.' : 'Modo general: responde de forma general y no uses ni solicites el expediente médico personal.'}`;
    const input = [];
    for (const m of cleanHistory(body.history)) input.push({role:m.role, content:[{type:'input_text',text:m.content}]});
    let userText = question;
    if (mode === 'personal') userText += '\n\nControles autorizados del paciente (datos mínimos; pueden estar incompletos):\n' + JSON.stringify(context);
    input.push({role:'user',content:[{type:'input_text',text:userText}]});
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method:'POST', headers:{'Authorization':`Bearer ${API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,instructions,input,max_output_tokens:700,store:false})
    });
    const result = await upstream.json().catch(()=>({}));
    if (!upstream.ok) {
      const msg = upstream.status === 401 ? 'La clave de IA configurada en el servidor no es válida.' : upstream.status === 429 ? 'El proveedor de IA ha limitado las consultas o falta saldo/crédito.' : 'El proveedor de IA no pudo procesar la consulta.';
      return send(res, upstream.status === 429 ? 429 : 502, {error:msg}, corsOrigin);
    }
    let answer = String(result.output_text || '').trim();
    if (!answer && Array.isArray(result.output)) answer = result.output.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim();
    if (!answer) return send(res, 502, {error:'El proveedor no devolvió texto de respuesta.'}, corsOrigin);
    return send(res, 200, {answer, mode, model:MODEL}, corsOrigin);
  } catch (err) {
    return send(res, 400, {error:err.message === 'Payload demasiado grande' ? err.message : 'No se pudo procesar la solicitud. Verifica la conexión e inténtalo de nuevo.'}, corsOrigin);
  }
});
server.listen(PORT, '0.0.0.0', () => { console.log(`SaludPlus AI server listening on ${PORT}`); });
