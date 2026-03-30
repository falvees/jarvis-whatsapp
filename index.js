const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const NOTION_KEY    = process.env.NOTION_KEY;
const NOTION_DB     = process.env.NOTION_DB;
const GROQ_KEY      = process.env.GROQ_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://evolution-api.railway.internal:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const INSTANCE      = process.env.WA_INSTANCE || 'natbox-whatsapp';
const PORT          = process.env.PORT || 3000;

// Grupos permitidos — adicione mais conforme necessário
const GRUPOS = {
  '120363329006221266@g.us': { grupo: 'Particular', nome: 'Agenda do dia' }
};

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── Helpers HTTP ──────────────────────────────────────────────────────────────
function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const mod = opts.protocol === 'http:' ? http : https;
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.setTimeout(25000, () => { req.destroy(); reject(new Error(opts.hostname + ' timeout')); });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── Notion ────────────────────────────────────────────────────────────────────
async function notionReq(path, method, body) {
  const b = body ? JSON.stringify(body) : undefined;
  const headers = {
    'Authorization': 'Bearer ' + NOTION_KEY,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };
  if (b) headers['Content-Length'] = Buffer.byteLength(b);
  const r = await httpReq({ hostname: 'api.notion.com', path, method, headers }, b);
  return JSON.parse(r.body);
}

async function buscarTarefas() {
  const d = await notionReq('/v1/databases/' + NOTION_DB + '/query', 'POST', {
    filter: { property: 'Status', status: { does_not_equal: 'Done' } },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    page_size: 50
  });
  return d.results || [];
}

async function criarTarefa({ titulo, responsavel, data, hora, prioridade, observacao, grupo }) {
  const props = {
    Tarefa:      { title: [{ text: { content: titulo } }] },
    Responsavel: { rich_text: [{ text: { content: responsavel || 'Felipe' } }] },
    Grupo:       { select: { name: grupo || 'Particular' } },
    Prioridade:  { select: { name: prioridade || 'Normal' } },
    Origem:      { rich_text: [{ text: { content: 'WhatsApp' } }] }
  };
  if (data) props.Data = { date: { start: data + (hora ? 'T' + hora + ':00' : '') } };
  if (observacao) props.Observacao = { rich_text: [{ text: { content: observacao } }] };
  await notionReq('/v1/pages', 'POST', { parent: { database_id: NOTION_DB }, properties: props });
}

async function concluirTarefa(pageId) {
  await notionReq('/v1/pages/' + pageId, 'PATCH', { properties: { Status: { status: { name: 'Done' } } } });
}

async function atualizarTarefa(pageId, status, observacao) {
  const props = { Status: { status: { name: status } } };
  if (observacao) props.Observacao = { rich_text: [{ text: { content: observacao } }] };
  await notionReq('/v1/pages/' + pageId, 'PATCH', { properties: props });
}

// ─── Formatação ────────────────────────────────────────────────────────────────
function norm(s) { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }

function stsInfo(s) {
  const n = norm(s);
  if (n === 'in progress' || n.includes('andamento')) return { l: 'Em andamento', i: '🔄' };
  if (n.includes('aguard'))                            return { l: 'Aguardando',   i: '⏸' };
  if (n === 'done')                                    return { l: 'Concluída',    i: '✅' };
  if (n.includes('trav') || n === 'blocked')           return { l: 'Travado',      i: '🚧' };
  return { l: 'Pendente', i: '⏳' };
}

function prioInfo(p) {
  const n = norm(p||'');
  if (n.includes('muito'))   return { c: '🔴', tag: '🔴 Muito Urgente' };
  if (n.includes('urgente')) return { c: '🟡', tag: '🟡 Urgente' };
  return { c: '⚪', tag: '' };
}

function fmtData(d) {
  if (!d) return '';
  const dt = new Date(d + (d.length === 10 ? 'T12:00:00' : ''));
  const hj = new Date(); hj.setHours(0,0,0,0);
  const am = new Date(hj); am.setDate(hj.getDate()+1);
  const tc = new Date(dt); tc.setHours(0,0,0,0);
  const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  let df = tc.getTime()===hj.getTime() ? 'Hoje' : tc.getTime()===am.getTime() ? 'Amanhã'
    : dias[dt.getDay()]+' '+String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0');
  if (d.length > 10) {
    const h = String(dt.getHours()).padStart(2,'0'), m = String(dt.getMinutes()).padStart(2,'0');
    if (!(h==='12'&&m==='00') && !(h==='00'&&m==='00')) df += ' às '+h+':'+m+'h';
  }
  return df;
}

function formatarLista(tarefas) {
  if (!tarefas||!tarefas.length) return '✅ Nenhuma tarefa pendente!';
  const pw = p => { const n=norm(p||''); return n.includes('muito')?0:n.includes('urgente')?1:2; };
  const sorted = [...tarefas].sort((a,b) => pw(a.properties?.Prioridade?.select?.name)-pw(b.properties?.Prioridade?.select?.name));
  let txt = '📋 *Tarefas · '+sorted.length+' abertas*\n';
  sorted.forEach((t,i) => {
    const titulo = t.properties?.Tarefa?.title?.[0]?.text?.content||'-';
    const resp   = t.properties?.Responsavel?.rich_text?.[0]?.text?.content||'-';
    const prio   = prioInfo(t.properties?.Prioridade?.select?.name);
    const dat    = t.properties?.Data?.date?.start||'';
    const grp    = t.properties?.Grupo?.select?.name||'';
    const st     = stsInfo(t.properties?.Status?.status?.name||'');
    const obs    = t.properties?.Observacao?.rich_text?.[0]?.text?.content||'';
    const df     = fmtData(dat);
    txt += '\n'+prio.c+' *#'+(i+1)+' '+titulo+'*\n';
    const pts = ['👤 '+resp];
    if (df)  pts.push('📅 '+df);
    if (grp) pts.push('📌 '+grp);
    txt += pts.join('  ·  ')+'\n';
    txt += st.i+' '+st.l+(prio.tag?'  ·  ⚡ '+prio.tag:'')+'\n';
    if (obs) txt += '💬 _'+obs+'_\n';
  });
  return txt;
}

// ─── Áudio WhatsApp ────────────────────────────────────────────────────────────
async function downloadAudio(url) {
  const wp = url.replace('https://',''); const si = wp.indexOf('/');
  return new Promise((resolve,reject) => {
    const req = https.get({hostname:wp.slice(0,si),path:wp.slice(si),headers:{'User-Agent':'WhatsApp/2.23.24.82 A'}},(res) => {
      if (res.statusCode!==200){req.destroy();reject(new Error('CDN '+res.statusCode));return;}
      const c=[]; res.on('data',d=>c.push(d)); res.on('end',()=>resolve(Buffer.concat(c))); res.on('error',reject);
    });
    req.setTimeout(10000,()=>{req.destroy();reject(new Error('CDN timeout'));});
    req.on('error',reject);
  });
}

function decryptAudio(encBuf, mediaKeyObj) {
  const mkArr = Object.keys(mediaKeyObj).sort((a,b)=>Number(a)-Number(b)).map(k=>mediaKeyObj[k]);
  const mediaKey = Buffer.from(mkArr);
  const km = crypto.hkdfSync('sha256',mediaKey,Buffer.alloc(32),Buffer.from('WhatsApp Audio Keys'),112);
  const dec = crypto.createDecipheriv('aes-256-cbc',Buffer.from(km.slice(16,48)),Buffer.from(km.slice(0,16)));
  dec.setAutoPadding(true);
  return Buffer.concat([dec.update(encBuf.slice(0,encBuf.length-10)),dec.final()]);
}

async function transcreverAudio(buf) {
  const b='JARVIS'+Date.now(), CR='\r\n';
  const body = Buffer.concat([
    Buffer.from('--'+b+CR+'Content-Disposition: form-data; name="file"; filename="audio.ogg"'+CR+'Content-Type: audio/ogg'+CR+CR),
    buf,
    Buffer.from(CR+'--'+b+CR+'Content-Disposition: form-data; name="model"'+CR+CR+'whisper-large-v3'+CR),
    Buffer.from('--'+b+CR+'Content-Disposition: form-data; name="prompt"'+CR+CR+'mensagem em português brasileiro'+CR),
    Buffer.from('--'+b+CR+'Content-Disposition: form-data; name="response_format"'+CR+CR+'json'+CR),
    Buffer.from('--'+b+'--'+CR)
  ]);
  const r = await httpReq({hostname:'api.groq.com',path:'/openai/v1/audio/transcriptions',method:'POST',
    headers:{'Authorization':'Bearer '+GROQ_KEY,'Content-Type':'multipart/form-data; boundary='+b,'Content-Length':body.length}},body);
  if (r.status!==200) throw new Error('Groq '+r.status);
  return (JSON.parse(r.body).text||'').trim();
}

// ─── Enviar WhatsApp ───────────────────────────────────────────────────────────
async function enviarMensagem(jid, texto) {
  const evoUrl = new URL(EVOLUTION_URL);
  const body = JSON.stringify({ number: jid, text: '🤖 '+texto });
  await httpReq({
    protocol: evoUrl.protocol, hostname: evoUrl.hostname,
    port: evoUrl.port||(evoUrl.protocol==='http:'?80:443),
    path: '/message/sendText/'+INSTANCE, method: 'POST',
    headers: {'apikey':EVOLUTION_KEY,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
  }, body);
}

// ─── Ferramentas Claude ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'buscar_tarefas',
    description: 'Busca todas as tarefas pendentes. Chame SEMPRE antes de listar, concluir ou atualizar.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'criar_tarefa',
    description: 'Cria uma nova tarefa. Se a mensagem mencionar MÚLTIPLOS itens, chame UMA VEZ POR ITEM.',
    input_schema: {
      type: 'object',
      properties: {
        titulo:      { type: 'string', description: 'Título da tarefa' },
        responsavel: { type: 'string', description: 'Nome do responsável (padrão: remetente da mensagem)' },
        data:        { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        hora:        { type: 'string', description: 'Hora no formato HH:MM' },
        prioridade:  { type: 'string', enum: ['Normal','Urgente','Muito Urgente'] },
        observacao:  { type: 'string', description: 'Observação ou detalhe adicional sobre a tarefa' },
        grupo:       { type: 'string', description: 'Grupo/empresa: Particular, Natbox, Digiverso, Felps' }
      },
      required: ['titulo']
    }
  },
  {
    name: 'concluir_tarefas',
    description: 'Marca tarefas como concluídas. Aceita: números ["1","2"], nomes ou ["todas"] para tudo.',
    input_schema: {
      type: 'object',
      properties: {
        identificadores: { type: 'array', items: { type: 'string' },
          description: 'Ex: ["1","3"] para números, ["todas"] para tudo, ["nome"] para busca por nome' }
      },
      required: ['identificadores']
    }
  },
  {
    name: 'atualizar_tarefa',
    description: 'Atualiza o status e/ou observação de uma tarefa existente.',
    input_schema: {
      type: 'object',
      properties: {
        identificador: { type: 'string', description: 'Número (#1, #2) ou nome da tarefa' },
        status:        { type: 'string', enum: ['In progress','Aguardando','Travado','Novo'] },
        observacao:    { type: 'string', description: 'Nova observação ou atualização sobre a tarefa' }
      },
      required: ['identificador']
    }
  }
];

// ─── Agente JARVIS ─────────────────────────────────────────────────────────────
async function agente({ texto, remetente, grupo, grupoNome, isAudio }) {
  const hoje = new Date().toISOString().slice(0,10);
  const system = [
    'Você é JARVIS, assistente pessoal inteligente do '+remetente+' via WhatsApp.',
    'Data de hoje: '+hoje+' | Grupo: '+grupo+' ('+grupoNome+')',
    isAudio ? '⚠️ Mensagem transcrita de ÁUDIO — interprete mesmo com pequenos erros.' : '',
    '',
    'Entenda QUALQUER linguagem natural: gírias, erros, abreviações, informal.',
    'Exemplos: "bora fechar tudo" = concluir todas, "mete aí reunião amanhã" = criar tarefa.',
    'Se múltiplos itens a criar, chame criar_tarefa UMA VEZ POR ITEM.',
    'Chame buscar_tarefas SEMPRE antes de listar, concluir ou atualizar.',
    '',
    'REGRAS:',
    '- LISTAR: retorne EXATAMENTE o texto da ferramenta, sem modificar.',
    '- CRIAR: diga "✅ [título] criada!" e mostre lista atualizada.',
    '- CONCLUIR: confirme e mostre o que resta.',
    '- ATUALIZAR: confirme a mudança.',
    '- CONVERSA: resposta curta, sem listas.',
    '',
    'Use APENAS * para negrito (nunca **). Responda em português brasileiro.'
  ].filter(Boolean).join('\n');

  const messages = [{ role: 'user', content: texto||'(mensagem)' }];
  let cache = null, listaCache = null, final = '';

  for (let iter = 0; iter < 8; iter++) {
    const resp = await client.messages.create({ model:'claude-haiku-4-5-20251001', max_tokens:1024, system, tools:TOOLS, messages });

    if (resp.stop_reason === 'end_turn') {
      final = resp.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim();
      break;
    }
    if (resp.stop_reason !== 'tool_use') {
      final = resp.content?.filter(c=>c.type==='text').map(c=>c.text).join('')||'Pronto!';
      break;
    }

    messages.push({ role:'assistant', content:resp.content });
    const results = [];

    for (const blk of resp.content) {
      if (blk.type !== 'tool_use') continue;
      let res = '';
      try {
        if (blk.name === 'buscar_tarefas') {
          cache = await buscarTarefas();
          res = formatarLista(cache);

        } else if (blk.name === 'criar_tarefa') {
          const inp = blk.input;
          await criarTarefa({ titulo:inp.titulo, responsavel:inp.responsavel||remetente,
            data:inp.data, hora:inp.hora, prioridade:inp.prioridade||'Normal',
            observacao:inp.observacao, grupo:inp.grupo||grupo });
          res = '✅ "'+inp.titulo+'" criada!';
          cache = null; listaCache = null;

        } else if (blk.name === 'concluir_tarefas') {
          if (!cache) cache = await buscarTarefas();
          const ids = blk.input.identificadores||[];
          const isAll = ids.some(x=>/^(todas?|tudo|all)$/i.test(x.trim()));
          let found = [];
          if (isAll) { found = [...cache]; }
          else {
            for (const id of ids) {
              const n = parseInt(id);
              if (!isNaN(n)&&n>0&&n<=cache.length) found.push(cache[n-1]);
              else found.push(...cache.filter(t=>norm(t.properties?.Tarefa?.title?.[0]?.text?.content||'').includes(norm(id))));
            }
          }
          const seen = new Set(); found = found.filter(t=>{if(seen.has(t.id))return false;seen.add(t.id);return true;});
          if (!found.length) { res='❌ Nenhuma tarefa encontrada.'; }
          else {
            await Promise.all(found.map(t=>concluirTarefa(t.id)));
            const tits = found.map(t=>t.properties?.Tarefa?.title?.[0]?.text?.content||'tarefa');
            res = found.length===cache.length&&found.length>1 ? '✅ Todas as '+found.length+' concluídas! 🎉'
                : found.length===1 ? '✅ "'+tits[0]+'" concluída!'
                : '✅ '+found.length+' concluídas:\n'+tits.map(t=>'  · '+t).join('\n');
            cache = null;
          }

        } else if (blk.name === 'atualizar_tarefa') {
          if (!cache) cache = await buscarTarefas();
          const n = parseInt(blk.input.identificador);
          const t = !isNaN(n)&&n>0&&n<=cache.length ? cache[n-1]
            : cache.find(x=>norm(x.properties?.Tarefa?.title?.[0]?.text?.content||'').includes(norm(blk.input.identificador)));
          if (!t) { res='❌ Tarefa não encontrada.'; }
          else {
            await atualizarTarefa(t.id, blk.input.status||'In progress', blk.input.observacao);
            const titulo = t.properties?.Tarefa?.title?.[0]?.text?.content||'tarefa';
            res = '🔄 "'+titulo+'" atualizada!' + (blk.input.observacao?' Obs: '+blk.input.observacao:'');
            cache = null;
          }
        }
      } catch(e) { res = '(erro: '+e.message.slice(0,60)+')'; }
      results.push({ type:'tool_result', tool_use_id:blk.id, content:res });
    }
    messages.push({ role:'user', content:results });
  }

  // Buscar lista final após criar tarefas
  if (final.includes('criada') && cache===null) {
    cache = await buscarTarefas();
    final = final+'\n\n'+formatarLista(cache);
  }

  // Corrigir ** → *
  return (final||'Pronto!').replace(/\*\*([^*]+)\*\*/g,'*$1*');
}

// ─── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder imediatamente ao Evolution API
  try {
    const data = req.body.data || req.body;
    const msg  = data.message || {};
    const key  = data.key || {};
    const jid  = key.remoteJid || '';
    const cfg  = GRUPOS[jid];
    if (!cfg) return;

    // Extrair texto
    let texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || '';
    if (texto.startsWith('🤖')) return; // anti-loop

    const isAudio = !!msg.audioMessage;
    if (!texto && !isAudio) return;

    const remetente = data.pushName || 'Felipe';

    // Processar áudio
    if (isAudio) {
      const am = msg.audioMessage;
      if (!am?.mediaKey || !am?.url) return;
      try {
        const decrypted = decryptAudio(await downloadAudio(am.url), am.mediaKey);
        texto = await transcreverAudio(decrypted);
        if (!texto) { await enviarMensagem(jid,'Não consegui ouvir o áudio. Pode escrever?'); return; }
        console.log('[AUDIO] '+remetente+': "'+texto+'"');
      } catch(e) {
        console.error('[AUDIO ERROR]', e.message);
        await enviarMensagem(jid,'Erro no áudio. Tente escrever a mensagem.');
        return;
      }
    }

    console.log('[MSG] '+remetente+' ('+cfg.grupo+'): "'+texto+'"');
    const resposta = await agente({ texto, remetente, grupo:cfg.grupo, grupoNome:cfg.nome, isAudio });
    await enviarMensagem(jid, resposta);
    console.log('[RESP] '+resposta.slice(0,100));

  } catch(e) { console.error('[ERROR]', e.message); }
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status:'ok', service:'JARVIS v2.1', uptime:process.uptime() }));

app.listen(PORT, () => console.log('🤖 JARVIS online | porta '+PORT));
