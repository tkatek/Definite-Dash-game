const CDP = 'http://127.0.0.1:9223';
const GAME = 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Client {
  constructor(target) {
    this.target = target;
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result ?? {});
        return;
      }
      for (const fn of this.events.get(message.method) ?? []) fn(message.params ?? {});
    });
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(name, fn) {
    const list = this.events.get(name) ?? [];
    list.push(fn);
    this.events.set(name, list);
  }
}

async function connect() {
  const target = await fetch(`${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    .then((response) => response.json());
  const client = new Client(target);
  await client.open();
  await Promise.all([
    client.call('Page.enable'), client.call('Runtime.enable'), client.call('Performance.enable'),
    client.call('Log.enable'), client.call('Network.enable'),
  ]);
  await client.call('Network.setCacheDisabled', { cacheDisabled: true });
  await client.call('Page.bringToFront');
  return client;
}

async function evaluate(client, expression) {
  const response = await client.call('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function poll(client, expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(${expression})`)) return;
    await sleep(60);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function resize(client, width, height) {
  await client.call('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await evaluate(client, `dispatchEvent(new Event('resize')); true`);
  await sleep(250);
}

async function boot(client, width, height) {
  await client.call('Page.bringToFront');
  await resize(client, width, height);
  const token = `${Date.now()}-${Math.random()}`;
  await client.call('Page.navigate', { url: `${GAME}?perf=${token}` });
  await poll(client, `location.search.includes('${token}') && document.readyState === 'complete' && (
    !document.getElementById('screen-start')?.classList.contains('hidden') ||
    !document.getElementById('screen-error')?.classList.contains('hidden'))`);
  const failure = await evaluate(client, `!document.getElementById('screen-error').classList.contains('hidden')
    ? document.getElementById('error-message').textContent : ''`);
  if (failure) throw new Error(failure);
  await evaluate(client, `document.getElementById('btn-play').click(); true`);
  await poll(client, `!document.getElementById('screen-game').classList.contains('hidden')`, 10000);
  await sleep(160);
}

const BOT = (options) => `(async () => {
  clearInterval(window.__botTimer);
  const data = await fetch('data/game-data.json').then((r) => r.json());
  const norm = (v) => String(v || '').replace(/_{3,}/, '___').replace(/\\s+/g, ' ').trim();
  const s = window.__bot = { options: ${JSON.stringify(options)}, ordinal: 0, key: '', feedbackKey: '',
    questionStart: 0, selections: [], approaches: [], errors: [], loops: {left:0,right:0}, times: {}, pause:null };
  const tick = () => {
    for (const side of ['left','right']) {
      const video = document.getElementById('roadside-video-' + side);
      if (!video || video.paused) continue;
      const old = s.times[side];
      if (Number.isFinite(old) && video.currentTime + 4 < old) s.loops[side]++;
      s.times[side] = video.currentTime;
    }
    if (s.options.cycle && !document.getElementById('screen-complete').classList.contains('hidden')) {
      document.getElementById('btn-play-again')?.click(); s.key=''; return;
    }
    if (s.options.cycle && !document.getElementById('screen-gameover').classList.contains('hidden')) {
      document.getElementById('btn-retry')?.click(); s.key=''; return;
    }
    if (document.getElementById('screen-game').classList.contains('hidden')) return;
    const feedback = document.getElementById('feedback');
    const sentence = norm(document.getElementById('sentence').textContent);
    const key = document.getElementById('hud-question').textContent + '|' + sentence;
    if (!feedback.classList.contains('hidden')) {
      if (s.feedbackKey !== key) {
        s.feedbackKey = key;
        s.approaches.push({ ordinal:s.ordinal, ms:performance.now()-s.questionStart,
          correct:feedback.classList.contains('feedback-correct'),
          rate:document.getElementById('roadside-video-left').playbackRate });
      }
      if (feedback.classList.contains('feedback-wrong') && performance.now()-s.questionStart > 5200) {
        const button=document.getElementById('btn-continue'); if (button && !button.hidden) button.click();
      }
      return;
    }
    if (!sentence || key === s.key) return;
    s.key=key; s.feedbackKey=''; s.ordinal++; s.questionStart=performance.now();
    const question=data.questions.find((q)=>norm(q.sentence)===sentence);
    if (!question) { s.errors.push('unmatched '+sentence); return; }
    const category=question.answer.category, wrong=s.options.wrongAt===s.ordinal;
    const gates=[...document.querySelectorAll('.answer-gate:not([hidden])')];
    const gate=gates.find((g)=>wrong ? g.dataset.category!==category : g.dataset.category===category);
    if (!gate) { s.errors.push('missing gate '+category); return; }
    const lane=Number(gate.dataset.lane);
    dispatchEvent(new KeyboardEvent('keydown',{key:lane===0?'ArrowRight':'ArrowLeft',bubbles:true}));
    document.querySelector('.answer-dock__choice[data-lane="'+lane+'"]')?.click();
    s.selections.push({ordinal:s.ordinal,lane,category,wrong,rate:document.getElementById('roadside-video-left').playbackRate});
  };
  window.__botTimer=setInterval(tick,45); tick();
  if (Number.isFinite(s.options.pauseAt)) setTimeout(()=>{
    const marker=document.querySelector('.lane-marker'), video=document.getElementById('roadside-video-left');
    const before={road:marker.style.transform,time:video.currentTime}; document.getElementById('btn-pause').click();
    setTimeout(()=>{ const during={road:marker.style.transform,time:video.currentTime,paused:video.paused};
      document.getElementById('btn-resume').click(); s.pause={before,during}; },650);
  },s.options.pauseAt);
  return true;
})()`;

async function startBot(client, options = {}) { await evaluate(client, BOT(options)); }

async function sampleFrames(client, duration) {
  return evaluate(client, `new Promise((resolve)=>{
    const gaps=[],tasks=[]; let last=null;
    const observer=PerformanceObserver.supportedEntryTypes?.includes('longtask')
      ? new PerformanceObserver((list)=>list.getEntries().forEach((e)=>tasks.push(e.duration))) : null;
    observer?.observe({type:'longtask'}); const start=performance.now();
    const frame=(now)=>{ if(last!==null)gaps.push(now-last); last=now;
      if(now-start<${duration}){requestAnimationFrame(frame);return;} observer?.disconnect();
      const sorted=[...gaps].sort((a,b)=>a-b), pct=(p)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]||0;
      resolve({durationMs:now-start,frames:gaps.length,fps:gaps.length/((now-start)/1000),medianMs:pct(.5),p95Ms:pct(.95),
        worstMs:sorted.at(-1)||0,over25:gaps.filter((x)=>x>25).length,over50:gaps.filter((x)=>x>50).length,
        longTasks:tasks.length,longTaskMs:tasks.reduce((a,b)=>a+b,0),longestTaskMs:Math.max(0,...tasks)});}; requestAnimationFrame(frame);
  })`);
}

async function metrics(client) {
  const { metrics } = await client.call('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function snapshot(client) {
  return evaluate(client, `(()=>{ const q=(v)=>{const x=v.getVideoPlaybackQuality?.();return x?{total:x.totalVideoFrames,dropped:x.droppedVideoFrames}:null};
    return {nodes:document.getElementsByTagName('*').length,markers:document.querySelectorAll('.lane-marker').length,
      details:[...document.querySelectorAll('.road-detail')].filter((e)=>!e.hidden).length,dust:document.querySelectorAll('.dust-puff').length,
      coins:document.querySelectorAll('.road-coin').length,effects:document.querySelectorAll('.coin-spark,.coin--collecting').length,
      videos:[...document.querySelectorAll('.roadside-video')].map((v)=>({src:v.currentSrc,width:v.videoWidth,height:v.videoHeight,
        rate:v.playbackRate,paused:v.paused,quality:q(v)})),bot:window.__bot??null};})()`);
}

async function pauseCheck(client) {
  const before=await evaluate(client,`({road:document.querySelector('.lane-marker').style.transform,time:document.getElementById('roadside-video-left').currentTime})`);
  await evaluate(client,`document.getElementById('btn-pause').click();true`); await sleep(430);
  const during=await evaluate(client,`({road:document.querySelector('.lane-marker').style.transform,time:document.getElementById('roadside-video-left').currentTime,
    paused:document.getElementById('roadside-video-left').paused,overlay:!document.getElementById('overlay-pause').classList.contains('hidden')})`);
  await evaluate(client,`document.getElementById('btn-resume').click();true`);
  return {overlay:during.overlay,roadFrozen:before.road===during.road,videoAdvance:during.time-before.time,videoPaused:during.paused};
}

async function runMatrix(client) {
  const groups=[[[1280,720],[1366,768],[1600,900],[1920,1080]],[[768,1024],[820,1180],[1024,768],[1024,1366]],[[360,800],[390,844],[412,915],[430,932]]];
  const rows=[];
  for(const group of groups){await boot(client,...group[0]);await startBot(client);
    for(const [width,height] of group){await resize(client,width,height);
      const input=await evaluate(client,`(()=>{const r=document.getElementById('runner'),before=Number(r.dataset.playerLane),t=performance.now();
        dispatchEvent(new KeyboardEvent('keydown',{key:before<2?'ArrowRight':'ArrowLeft',bubbles:true}));
        return{before,after:Number(r.dataset.playerLane),ms:performance.now()-t};})()`);
      const state=await evaluate(client,`({layout:document.getElementById('runner').dataset.roadLayout,markers:document.querySelectorAll('.lane-marker').length,
        details:[...document.querySelectorAll('.road-detail')].filter((e)=>!e.hidden).length,dust:document.querySelectorAll('.dust-puff').length,
        coins:document.querySelectorAll('.road-coin').length,src:document.getElementById('roadside-video-left').currentSrc,
        video:[document.getElementById('roadside-video-left').videoWidth,document.getElementById('roadside-video-left').videoHeight],
        gateDuration:getComputedStyle(document.querySelector('.answer-gate')).transitionDuration,
        playerDuration:getComputedStyle(document.getElementById('player')).transitionDuration})`);
      rows.push({width,height,...state,input,sample:await sampleFrames(client,900)});
    }
    rows.at(-1).pause=await pauseCheck(client); await evaluate(client,`clearInterval(window.__botTimer);true`);
  } return rows;
}

async function runVariant(client, disableVideo, disableDetails) {
  await boot(client,1280,720);await startBot(client);
  if(disableVideo)await evaluate(client,`document.getElementById('roadside-world').style.display='none';
    window.__videoOffTimer=setInterval(()=>document.querySelectorAll('.roadside-video').forEach(v=>v.pause()),20);
    document.querySelectorAll('.roadside-video').forEach(v=>v.pause());true`);
  if(disableDetails)await evaluate(client,`document.querySelectorAll('.road-detail').forEach(e=>e.style.display='none');true`);
  const m0=await metrics(client),s0=await snapshot(client),sample=await sampleFrames(client,12000),m1=await metrics(client),s1=await snapshot(client);
  await evaluate(client,`clearInterval(window.__botTimer);clearInterval(window.__videoOffTimer);true`);
  return{disableVideo,disableDetails,sample,metrics:{taskMs:(m1.TaskDuration-m0.TaskDuration)*1000,scriptMs:(m1.ScriptDuration-m0.ScriptDuration)*1000,
    layoutMs:(m1.LayoutDuration-m0.LayoutDuration)*1000,recalcMs:(m1.RecalcStyleDuration-m0.RecalcStyleDuration)*1000,
    layouts:m1.LayoutCount-m0.LayoutCount,styles:m1.RecalcStyleCount-m0.RecalcStyleCount,heap:m1.JSHeapUsedSize-m0.JSHeapUsedSize},before:s0,after:s1};
}

async function runLong(client) {
  await boot(client,1280,720);await startBot(client,{wrongAt:4,pauseAt:14000,cycle:true});
  const m0=await metrics(client),s0=await snapshot(client),sample=await sampleFrames(client,60000),m1=await metrics(client),s1=await snapshot(client);
  await evaluate(client,`clearInterval(window.__botTimer);true`);
  return{sample,before:s0,after:s1,delta:{nodes:s1.nodes-s0.nodes,heap:m1.JSHeapUsedSize-m0.JSHeapUsedSize,
    layouts:m1.LayoutCount-m0.LayoutCount,styles:m1.RecalcStyleCount-m0.RecalcStyleCount,taskMs:(m1.TaskDuration-m0.TaskDuration)*1000}};
}

async function main(){const mode=process.argv[2]||'all',client=await connect(),issues=[];
  client.on('Runtime.exceptionThrown',({exceptionDetails})=>issues.push(exceptionDetails.exception?.description||exceptionDetails.text));
  client.on('Log.entryAdded',({entry})=>{if(entry.level==='error'||entry.level==='warning')issues.push(entry.level+': '+entry.text)});
  const out={};if(mode==='matrix'||mode==='all')out.matrix=await runMatrix(client);
  if(mode==='one')out.variant=await runVariant(client,false,false);
  if(mode==='variants'||mode==='all')out.variants=[await runVariant(client,false,false),await runVariant(client,true,false),await runVariant(client,true,true)];
  if(mode==='long'||mode==='all')out.long=await runLong(client);out.consoleIssues=issues;console.error(JSON.stringify(out,null,2));
  await fetch(`${CDP}/json/close/${client.target.id}`);}
main().catch((error)=>{console.error(error.stack||error);process.exitCode=1});
