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
  '120363329006221266@g.us': { grupo: 'Particular',  nome: 'Agenda do dia',  empresa: 'Pessoal' },
  '120363426207796139@g.us': { grupo: 'Natbox',      nome: 'AGENDA - Natbox', empresa: 'Natbox'  }
};

// JIDs do Felipe para @menção (LID = formato interno do WhatsApp)
const FELIPE_LID = '41098558865548@lid';
const FELIPE_JID = '553491201226@s.whatsapp.net';

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
    if (body) req.write(Buffer.isBuffer(body) ? body : (typeof body === 'string' ? body : JSON.stringify(body)));
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

async function buscarTarefas(grupoFiltro) {
  // Retry em caso de resultado vazio (timing issue com Notion API)
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const queryBody = {
      filter: { property: 'Status', status: { does_not_equal: 'Done' } },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 50
    };
    // Filtrar por grupo se especificado
    if (grupoFiltro) {
      queryBody.filter = {
        and: [
          { property: 'Status', status: { does_not_equal: 'Done' } },
          { property: 'Grupo', select: { equals: grupoFiltro } }
        ]
      };
    }
    const d = await notionReq('/v1/databases/' + NOTION_DB + '/query', 'POST', queryBody);
    const results = d.results || [];
    if (results.length > 0 || tentativa === 2) return results;
    await new Promise(res => setTimeout(res, 1000)); // aguardar Notion commitar
  }
  return [];
}

// Emojis por tipo de item
const TIPO_EMOJI = { Tarefa: '📋', Nota: '📝', Ideia: '💡', Lembrete: '⏰' };

async function criarTarefa({ titulo, tipo, responsavel, data, hora, prioridade, observacao, grupo }) {
  const tipoFinal = tipo || 'Tarefa';
  const props = {
    Tarefa:      { title: [{ text: { content: titulo } }] },
    Responsavel: { rich_text: [{ text: { content: responsavel || 'Felipe' } }] },
    Grupo:       { select: { name: grupo || 'Particular' } },
    Prioridade:  { select: { name: prioridade || 'Normal' } },
    Origem:      { rich_text: [{ text: { content: 'WhatsApp' } }] }
  };
  if (data) props.Data = { date: { start: data + (hora ? 'T' + hora + ':00' : '') } };
  if (observacao) props.Observacao = { rich_text: [{ text: { content: observacao } }] };
  // Tipo armazenado na Origem para diferenciar
  props.Origem = { rich_text: [{ text: { content: 'WhatsApp | ' + tipoFinal } }] };
  await notionReq('/v1/pages', 'POST', { parent: { database_id: NOTION_DB }, properties: props });
  return tipoFinal;
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
function formatarResumo(tarefas, grupoNome) {
  if (!tarefas || !tarefas.length) return '✅ Nenhuma tarefa pendente! Tudo limpo 🎯';

  const hoje = new Date(); hoje.setHours(0,0,0,0);
  let abertas = 0, emAndamento = 0, urgentes = 0, aguardando = 0, atrasadas = 0;

  tarefas.forEach(t => {
    const st  = norm(t.properties?.Status?.status?.name || '');
    const pr  = norm(t.properties?.Prioridade?.select?.name || '');
    const dat = t.properties?.Data?.date?.start || '';

    if (st.includes('andamento')) emAndamento++;
    if (st.includes('aguard'))    aguardando++;
    if (pr.includes('urgente'))   urgentes++;
    if (dat) {
      const d = new Date(dat + (dat.length === 10 ? 'T12:00:00' : ''));
      d.setHours(0,0,0,0);
      if (d < hoje) atrasadas++;
    }
    abertas++;
  });

  // Foco do dia — top 3 por prioridade e data
  const pw = p => { const n=norm(p||''); return n.includes('muito')?0:n.includes('urgente')?1:2; };
  const sorted = [...tarefas].sort((a, b) => {
    const pd = pw(a.properties?.Prioridade?.select?.name) - pw(b.properties?.Prioridade?.select?.name);
    if (pd !== 0) return pd;
    const da = a.properties?.Data?.date?.start || 'z';
    const db = b.properties?.Data?.date?.start || 'z';
    return da.localeCompare(db);
  });

  const foco = sorted.slice(0, 3).map(t => {
    const titulo = t.properties?.Tarefa?.title?.[0]?.text?.content || '-';
    const dat    = t.properties?.Data?.date?.start || '';
    const obs    = t.properties?.Observacao?.rich_text?.[0]?.text?.content || '';
    const df     = fmtData(dat);
    let linha = '• *' + titulo + '*';
    if (df)  linha += ' (' + df + ')';
    if (obs) linha += ' — ' + obs;
    return linha;
  }).join('\n');

  const frases = [
    'Bora fechar tudo! 💪',
    'Foco total hoje! 🎯',
    'Um de cada vez! 🚀',
    'Você consegue! ⚡',
    'Vamos nessa! 🔥'
  ];
  const frase = frases[Math.floor(Math.random() * frases.length)];

  return [
    '🌅 *Resumo — ' + (grupoNome || 'Particular') + '*',
    '',
    '📋 Abertas: ' + abertas,
    '🔄 Em andamento: ' + emAndamento,
    '⚠️ Urgentes: ' + urgentes,
    '⏸ Aguardando: ' + aguardando,
    '📅 Atrasadas: ' + atrasadas,
    '',
    '🔥 *Foco de hoje:*',
    foco,
    '',
    frase
  ].join('\n');
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
  // mediaKey pode ser Buffer, Uint8Array ou objeto {0:byte, 1:byte...}
  let mediaKey;
  if (Buffer.isBuffer(mediaKeyObj)) {
    mediaKey = mediaKeyObj;
  } else if (mediaKeyObj instanceof Uint8Array) {
    mediaKey = Buffer.from(mediaKeyObj);
  } else if (typeof mediaKeyObj === 'object') {
    const mkArr = Object.keys(mediaKeyObj).sort((a,b)=>Number(a)-Number(b)).map(k=>mediaKeyObj[k]);
    mediaKey = Buffer.from(mkArr);
  } else {
    throw new Error('mediaKey formato desconhecido: ' + typeof mediaKeyObj);
  }
  console.log('[AUDIO] mediaKey length:', mediaKey.length, 'encBuf length:', encBuf.length);
  const km = crypto.hkdfSync('sha256',mediaKey,Buffer.alloc(32),Buffer.from('WhatsApp Audio Keys'),112);
  const dec = crypto.createDecipheriv('aes-256-cbc',Buffer.from(km.slice(16,48)),Buffer.from(km.slice(0,16)));
  dec.setAutoPadding(true);
  return Buffer.concat([dec.update(encBuf.slice(0,encBuf.length-10)),dec.final()]);
}

async function transcreverAudio(buf) {
  // Boundary curto e fixo para evitar "bufio: buffer full" no Groq
  const b = 'X' + Math.random().toString(36).slice(2,10);
  const CRLF = '\r\n';

  // Construir multipart manualmente com boundary curto
  const part1 = Buffer.from(
    '--' + b + CRLF +
    'Content-Disposition: form-data; name="file"; filename="audio.ogg"' + CRLF +
    'Content-Type: audio/ogg' + CRLF +
    CRLF
  );
  const part2 = Buffer.from(
    CRLF + '--' + b + CRLF +
    'Content-Disposition: form-data; name="model"' + CRLF +
    CRLF +
    'whisper-large-v3' + CRLF +
    '--' + b + CRLF +
    'Content-Disposition: form-data; name="response_format"' + CRLF +
    CRLF +
    'json' + CRLF +
    '--' + b + '--' + CRLF
  );

  const body = Buffer.concat([part1, buf, part2]);
  const contentType = 'multipart/form-data; boundary=' + b;

  console.log('[AUDIO] Groq request: boundary='+b+' body='+body.length+'bytes audio='+buf.length+'bytes');

  const r = await httpReq({
    hostname: 'api.groq.com',
    path: '/openai/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + GROQ_KEY,
      'Content-Type': contentType,
      'Content-Length': body.length
    }
  }, body);

  if (r.status !== 200) throw new Error('Groq ' + r.status + ': ' + r.body.slice(0, 200));
  return (JSON.parse(r.body).text || '').trim();
}

// ─── Enviar WhatsApp ───────────────────────────────────────────────────────────
async function enviarMensagem(jid, texto) {
  const evoUrl = new URL(EVOLUTION_URL);
  const bodyObj = { number: jid, text: '🤖 ' + texto };
  const body = JSON.stringify(bodyObj);
  await httpReq({
    protocol: evoUrl.protocol, hostname: evoUrl.hostname,
    port: evoUrl.port||(evoUrl.protocol==='http:'?80:443),
    path: '/message/sendText/' + INSTANCE, method: 'POST',
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
    description: 'Cria novo item. Se múltiplos itens, chame UMA VEZ POR ITEM.',
    input_schema: {
      type: 'object',
      properties: {
        titulo:      { type: 'string', description: 'Título do item' },
        tipo:        { type: 'string', enum: ['Tarefa','Nota','Ideia','Lembrete'], description: 'Tipo (padrão: Tarefa). Nota=anotação, Ideia=criativa, Lembrete=com data' },
        responsavel: { type: 'string', description: 'Nome do responsável. EXTRAIA da mensagem se mencionado (ex: responsavel João, pra Adriane, para o Pedro)' },
        data:        { type: 'string', description: 'YYYY-MM-DD' },
        hora:        { type: 'string', description: 'HH:MM' },
        prioridade:  { type: 'string', enum: ['Normal','Urgente','Muito Urgente'] },
        observacao:  { type: 'string', description: 'Observação adicional' },
        grupo:       { type: 'string', description: 'Particular, Natbox, Digiverso, Felps' }
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
    name: 'resumo_tarefas',
    description: 'Gera um resumo/status das tarefas. Use quando pedir: resumo, status, o que tem, o que tá rolando, agenda do dia.',
    input_schema: { type: 'object', properties: {}, required: [] }
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
    'Tipos de item: Tarefa (padrão), Nota (📝 anotação), Ideia (💡 criativa), Lembrete (⏰ com data).',
    'Responsável: SEMPRE extraia da mensagem se mencionado. Ex: "responsavel adriane"→responsavel:"Adriane", "pra o João"→responsavel:"João", "para Marcos"→responsavel:"Marcos". Se não mencionado, use o remetente.',
    'Concluir: quando pedir "concluir todas", "fechar tudo", "bora fechar", "conclui tudo" → passe identificadores:["todas"].',
    'Exemplos tipo: "anota aí..."→Nota, "tive uma ideia..."→Ideia, "me lembra amanhã..."→Lembrete.',
    'Exemplos: "bora fechar tudo" = concluir todas, "mete aí reunião amanhã" = criar tarefa.',
    'Se múltiplos itens a criar, chame criar_tarefa UMA VEZ POR ITEM.',
    'Chame buscar_tarefas SEMPRE antes de listar, concluir ou atualizar.',
    '',
    'REGRAS:',
    '- LISTAR (tarefas/lista): chame buscar_tarefas e retorne SEU RESULTADO EXATO, sem alterar nada. NUNCA resuma, reformate ou reescreva a lista.',
    '',
    '- RESUMO (resumo/status/o que tem/o que tá rolando): use este formato:',
    '  🌅 Resumo — [Grupo]',
    '  ',
    '  📋 Abertas: X',
    '  🔄 Em andamento: X',
    '  ⚠️ Urgentes: X',
    '  ⏸ Aguardando: X',
    '  📅 Atrasadas: X',
    '  ',
    '  🔥 Foco de hoje:',
    '  • [tarefa1] (data/hora)',
    '  • [tarefa2] (data/hora)',
    '  (máx 3, as mais urgentes/próximas)',
    '  [emoji] frase motivacional curta',
    '',
    '- CRIAR: mostre APENAS a tarefa criada no formato abaixo. NÃO liste outras tarefas. NÃO busque a lista.',
    '  ✅ Tarefa criada',
    '  *[título da tarefa]*',
    '  ⚡ Prioridade: [Normal/Urgente/Muito Urgente]',
    '  📅 Prazo: [data/hora ou "Sem prazo"]',
    '  💬 Obs: [observação ou omitir se não tiver]',
    '',
    '- CONCLUIR (1 tarefa): "✅ *[tarefa]* concluída!"',
    '- CONCLUIR (múltiplas): "✅ [N] tarefas concluídas! 🎉"',
    '- ATUALIZAR: use este formato:',
    '  🔄 *[tarefa]* atualizada',
    '  Status: [novo status]',
    '  [obs se tiver]',
    '',
    '- CONVERSA: resposta curta e natural.',
    '',
    'Use APENAS * para negrito (nunca **). Responda em português brasileiro.'
  ].filter(Boolean).join('\n');

  const messages = [{ role: 'user', content: texto||'(mensagem)' }];
  let cache = null, listaCache = null, criacaoCache = null, final = '';

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
          cache = await buscarTarefas(grupo);
          if (!cache.length) {
            await new Promise(r => setTimeout(r, 2000));
            cache = await buscarTarefas(grupo);
          }
          res = formatarLista(cache);
          listaCache = res; // garantir fallback se IA reformatar

        } else if (blk.name === 'criar_tarefa') {
          const inp = blk.input;
          const tipoSalvo = await criarTarefa({ titulo:inp.titulo, tipo:inp.tipo||'Tarefa',
            responsavel:inp.responsavel||remetente,
            data:inp.data, hora:inp.hora, prioridade:inp.prioridade||'Normal',
            observacao:inp.observacao, grupo:inp.grupo||grupo });
          const emoji = TIPO_EMOJI[tipoSalvo] || '✅';
          const prazo = inp.data ? '\n📅 Prazo: ' + (inp.data === new Date().toISOString().slice(0,10) ? 'Hoje' : inp.data) + (inp.hora ? ' às ' + inp.hora + 'h' : '') : '';
          const obs = inp.observacao ? '\n💬 Obs: ' + inp.observacao : '';
          const prio = inp.prioridade && inp.prioridade !== 'Normal' ? '\n⚡ Prioridade: ' + inp.prioridade : '';
          res = emoji+' *'+tipoSalvo+' criada*\n*'+inp.titulo+'*'+prio+prazo+obs;
          criacaoCache = res; // guardar para usar se IA reformatar
          cache = null; listaCache = null;

        } else if (blk.name === 'concluir_tarefas') {
          if (!cache) cache = await buscarTarefas(grupo);
          const ids = blk.input.identificadores||[];
          const isAll = ids.some(x=>/^(todas?|tudo|all|everything)$/i.test(x.trim()));
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
            cache = null; listaCache = null; criacaoCache = null;
          }

        } else if (blk.name === 'atualizar_tarefa') {
          if (!cache) cache = await buscarTarefas(grupo);
          const n = parseInt(blk.input.identificador);
          const t = !isNaN(n)&&n>0&&n<=cache.length ? cache[n-1]
            : cache.find(x=>norm(x.properties?.Tarefa?.title?.[0]?.text?.content||'').includes(norm(blk.input.identificador)));
          if (!t) { res='❌ Tarefa não encontrada.'; }
          else {
            await atualizarTarefa(t.id, blk.input.status||'In progress', blk.input.observacao);
            const titulo = t.properties?.Tarefa?.title?.[0]?.text?.content||'tarefa';
            res = '🔄 "'+titulo+'" atualizada!' + (blk.input.observacao?' Obs: '+blk.input.observacao:'');
            cache = null; listaCache = null; criacaoCache = null;
          }
        }
      } catch(e) { res = '(erro: '+e.message.slice(0,60)+')'; }
      results.push({ type:'tool_result', tool_use_id:blk.id, content:res });
    }
    messages.push({ role:'user', content:results });
  }

  // NÃO buscar lista após criar — apenas confirmar a criação

  // Se a IA reformatou lista ou resumo, usar o texto direto da ferramenta
  // Se a IA reformatou: usar resultado direto da ferramenta
  const isListaCorreta = final.includes('📋 *Tarefas ·') || final.includes('🌅 *Resumo') || final.includes('✅ Nenhuma tarefa pendente');
  if (listaCache && !isListaCorreta) {
    final = listaCache;
  }
  // Se IA reformatou resposta de criação: usar formato clean direto
  // Usar criacaoCache apenas se a IA não gerou resposta própria sobre criação
  const finalTemCriacao = final.includes('criada') || final.includes('criado') || final.includes('anotado') || final.includes('Ideia') || final.includes('Lembrete') || final.includes('Nota');
  if (criacaoCache && !finalTemCriacao) {
    final = criacaoCache;
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
        console.error('[AUDIO ERROR]', e.message); console.error('[AUDIO ERROR STACK]', e.stack?.slice(0,300));
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

// ─── Deploy Hook ──────────────────────────────────────────────────────────────
app.post('/deploy-hook', async (req, res) => {
  res.sendStatus(200);
  try {
    const payload = req.body;
    const branch = (payload && payload.ref) ? payload.ref.replace('refs/heads/', '') : '';
    if (branch !== 'master') return;
    console.log('[DEPLOY] Push no master detectado, triggering redeploy...');
    const https = require('https');
    const body = JSON.stringify({ query: 'mutation { githubRepoUpdate(input: { serviceId: "ee0b45cb-1dda-4a88-965a-657ceefa569c", projectId: "a9b85a94-37cc-486b-97b2-c762b70b8749", environmentId: "35d833e0-4128-43ae-9f08-302932bf9a6a" }) }' });
    const r = https.request({
      hostname: 'backboard.railway.com', path: '/graphql/v2', method: 'POST',
      headers: { 'Authorization': 'Bearer f05476dd-6791-42b6-b280-ee9acd845507', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (rs) => { console.log('[DEPLOY] Railway:', rs.statusCode); });
    r.write(body); r.end();
  } catch(e) { console.error('[DEPLOY ERROR]', e.message); }
});

app.get('/health', (_, res) => res.json({ status:'ok', service:'JARVIS v2.1', uptime:process.uptime() }));

// ─── Resumo automático às 9h ─────────────────────────────────────────────
function agendarResumo() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const prox9h = new Date(brasilia);
  prox9h.setHours(9, 0, 0, 0);
  if (brasilia >= prox9h) prox9h.setDate(prox9h.getDate() + 1);
  const msAte9h = prox9h - brasilia;
  console.log('[CRON] Próximo resumo em ' + Math.round(msAte9h/60000) + 'min (' + prox9h.toLocaleString('pt-BR') + ')');
  setTimeout(async () => {
    try {
      console.log('[CRON] Enviando resumo automático...');
      for (const [jid, cfg] of Object.entries(GRUPOS)) {
        const grupoKey = cfg.grupo;
        const tarefas = await buscarTarefas(grupoKey);
        const msg = formatarResumo(tarefas, cfg.nome);
        await enviarMensagem(jid, msg);
        console.log('[CRON] Resumo enviado para', cfg.nome);
      }
    } catch(e) { console.error('[CRON ERROR]', e.message); }
    agendarResumo();
  }, msAte9h);
}
agendarResumo();

app.listen(PORT, () => console.log('🤖 JARVIS v2 online | porta '+PORT));
