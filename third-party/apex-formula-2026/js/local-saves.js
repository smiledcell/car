import { DRIVERS, TEAMS, CALENDAR, STORAGE_SUFFIX } from './data.js';
import { TRACKS } from './tracks.js';
export const BACKUP_FORMAT = 'apex-formula-local-saves';
export const CAREER_KEY = 'apexf1_2026_career' + (STORAGE_SUFFIX || '');
export const MAX_BACKUP_BYTES = 24 * 1024 * 1024;
const PREFIX = 'apexf1_tt_v1:';
const EXACT = new Set(['apexf1_settings', 'apexf1_last_race', CAREER_KEY, 'apexf1_onboarding_v1']);
const drivers = new Set(DRIVERS.map(d => d.id)), teams = new Set(TEAMS.map(t => t.id));
const record = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const finite = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
const fail = message => { throw new Error(message); };
const trackExists = id => typeof id === 'string' && Object.hasOwn(TRACKS, id);
function trialIds(key) {
  const p = key.slice(PREFIX.length).split(':');
  return p.length === 2 && trackExists(p[0]) && drivers.has(p[1]) ? p : null;
}
export function isSaveKey(key) {
  return typeof key === 'string' && (EXACT.has(key) || (key.startsWith(PREFIX) && !!trialIds(key)));
}
const bools = new Set(['quali', 'tc', 'abs', 'autoGear', 'nametags', 'autoPause', 'touchControls', 'headMotion', 'gtao']);
// Keep historical settings (including gtao) while allowlisting current official UI options.
const enums = { graphicsQuality: ['auto','low','medium','high'], cameraProfile: ['tight','broadcast','cinematic'], steeringResponse: ['calm','balanced','direct'], cockpitFov: ['focused','natural','wide'], cockpitSeat: ['low','standard','high'], racingLine: ['off','braking','full'], cameraMotion: ['off','subtle','full'], padRumble: [0,0.35,0.65,1] };
function settings(v) {
  return record(v) && Object.entries(v).every(([k,n]) => bools.has(k) ? typeof n === 'boolean' : k === 'difficulty' ? integer(n,2) : k === 'distance' ? integer(n,3) : k === 'volume' ? finite(n,0,1) : Object.hasOwn(enums,k) && enums[k].includes(n));
}
function counter(v, ids) { return record(v) && Object.entries(v).every(([id,n]) => ids.has(id) && integer(n,1000000)); }
function career(v) {
  if (!record(v) || !drivers.has(v.playerDriverId) || !integer(v.roundIndex,CALENDAR.length) || !Array.isArray(v.results) || v.results.length !== v.roundIndex) return false;
  if (!['driverPoints','wins','podiums'].every(k => counter(v[k],drivers)) || !['teamPoints','teamWins','teamPodiums'].every(k => counter(v[k],teams))) return false;
  return v.results.every((r,i) => {
    const race = CALENDAR[i];
    if (!record(r) || r.round !== race.round || r.trackId !== race.trackId || r.gp !== race.gp || !Array.isArray(r.top3) || r.top3.length < 1 || r.top3.length > 3 || !r.top3.every(id => drivers.has(id)) || new Set(r.top3).size !== r.top3.length || !(r.playerPos === null || (Number.isInteger(r.playerPos) && r.playerPos >= 1 && r.playerPos <= DRIVERS.length)) || !(r.fastestLap === null || drivers.has(r.fastestLap))) return false;
    return r.playerPos !== null && r.playerPos <= 3 ? r.top3[r.playerPos-1] === v.playerDriverId : !r.top3.includes(v.playerDriverId);
  });
}
function trial(v,key) {
  const [trackId,driverId] = trialIds(key);
  if (!record(v) || v.version !== 1 || v.trackId !== trackId || v.driverId !== driverId || !finite(v.lap,.001,86400) || !Array.isArray(v.sectors) || v.sectors.length > 3 || !v.sectors.every(n => n === null || finite(n,0,86400)) || typeof v.savedAt !== 'string' || v.savedAt.length > 64 || !Number.isFinite(Date.parse(v.savedAt)) || !Array.isArray(v.frames) || v.frames.length < 20 || v.frames.length > 100000) return false;
  let time = -1, distance = -1;
  return v.frames.every(f => {
    if (!Array.isArray(f) || f.length !== 6 || !finite(f[0],0,86400) || f[0] < time || !f.slice(1,5).every(n => finite(n,-10000000,10000000)) || !finite(f[5],0,10000000) || f[5]+2 < distance) return false;
    time=f[0]; distance=f[5]; return true;
  });
}
export function validateSaveValue(key,raw) {
  if (!isSaveKey(key) || typeof raw !== 'string' || raw.length > MAX_BACKUP_BYTES) fail('不支持的存档项目：'+key);
  if (key === 'apexf1_onboarding_v1') { if (raw !== '1') fail('新手提示记录无效'); return raw; }
  let v; try { v=JSON.parse(raw); } catch { fail('存档 JSON 损坏：'+key); }
  const ok = key === 'apexf1_settings' ? settings(v) : key === 'apexf1_last_race' ? record(v) && drivers.has(v.driverId) && trackExists(v.trackId) : key === CAREER_KEY ? career(v) : trial(v,key);
  if (!ok) fail('存档内容校验失败：'+key);
  return raw;
}
export function validateBackup(v) {
  if (!record(v) || v.format !== BACKUP_FORMAT || v.version !== 1 || !record(v.storage)) fail('不是受支持的 APEX 本地备份（版本 1）');
  const entries=Object.entries(v.storage), storage={}; let size=0;
  if (entries.length > 4+Object.keys(TRACKS).length*DRIVERS.length) fail('备份项目过多');
  for (const [key,raw] of entries) {
    validateSaveValue(key,raw); size+=key.length+raw.length;
    if (size > MAX_BACKUP_BYTES) fail('备份过大'); storage[key]=raw;
  }
  return {format:BACKUP_FORMAT,version:1,storage};
}
export function collectBackup(store) {
  const storage={};
  for (let i=0;i<store.length;i++) { const key=store.key(i); if (isSaveKey(key)) storage[key]=store.getItem(key); }
  return {format:BACKUP_FORMAT,version:1,createdAt:new Date().toISOString(),storage};
}
// Multi-key storage writes are not atomic: retain all prior entries for rollback.
export function restoreBackup(store,input) {
  const backup=validateBackup(input), before=collectBackup(store).storage;
  const keys=new Set([...Object.keys(before),...Object.keys(backup.storage)]);
  try {
    for (const key of keys) { if (Object.hasOwn(backup.storage,key)) store.setItem(key,backup.storage[key]); else store.removeItem(key); }
  } catch (error) {
    let failed=false;
    for (const key of keys) { try { if (Object.hasOwn(before,key)) store.setItem(key,before[key]); else store.removeItem(key); } catch { failed=true; } }
    fail(failed ? '恢复失败，且旧记录回滚不完整。请保留已下载的恢复前备份。' : '恢复失败，已回滚旧记录：'+error.message);
  }
}
function download(value,suffix='') {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}));
  const a=document.createElement('a'); a.href=url; a.download=`apex-local-saves${suffix}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function installLocalSaves() {
  if (typeof document === 'undefined' || document.getElementById('apex-local-saves')) return;
  const root=document.createElement('div'); root.id='apex-local-saves';
  root.style.cssText='position:fixed;right:12px;top:12px;z-index:10000;font:13px/1.6 system-ui,sans-serif;color:#eee;max-width:calc(100vw - 24px)';
  root.innerHTML=`<button type="button" data-open aria-expanded="false" style="background:#161b25;color:#fff;border:1px solid #667080;border-radius:5px;padding:5px 10px;cursor:pointer">本地存档</button>
<section hidden aria-label="本地存档管理" style="margin-top:6px;width:360px;max-width:calc(100vw - 24px);max-height:calc(100vh - 75px);overflow:auto;background:#10151f;border:1px solid #667080;border-radius:8px;padding:16px;box-sizing:border-box;box-shadow:0 8px 32px #0009">
<strong>本地存档 / 备份与恢复</strong><p>游戏会自动保存设置、锦标赛进度与计时赛最佳记录。<b>不支持进行中的比赛续存</b>，退出或刷新会丢失当前比赛进度。</p>
<p>记录属于当前浏览器与当前网址；以 file:// 打开时还可能与文件路径有关。换浏览器、路径或端口可能读不到原记录，清除浏览器数据会丢失记录。请下载备份。</p>
<p data-status role="status" aria-live="polite"></p><div style="display:flex;flex-wrap:wrap;gap:8px"><button type="button" data-export>导出备份 JSON</button><button type="button" data-import>导入备份 JSON</button><button type="button" data-close>关闭</button></div><input type="file" accept="application/json,.json" hidden></section>`;
  document.body.append(root);
  const panel=root.querySelector('section'), status=root.querySelector('[data-status]'), open=root.querySelector('[data-open]'), input=root.querySelector('input');
  function availability() {
    try {
      const store=window.localStorage, probe='apexf1_backup_probe:'+Date.now()+':'+Math.random();
      store.setItem(probe,'1'); if (store.getItem(probe)!=='1') throw new Error('写入验证失败'); store.removeItem(probe);
      const keys=Object.keys(collectBackup(store).storage);
      status.textContent=`本地存储可读写；已有 ${keys.length} 项记录，其中计时赛记录 ${keys.filter(k=>k.startsWith(PREFIX)).length} 项。此检查不保证以后不会遇到配额或浏览器限制。`;
      root.querySelector('[data-import]').disabled=false;
      open.textContent='本地存档';
      open.title='管理本地备份与恢复';
    } catch (error) {
      status.textContent='本地存储不可写：'+error.message+'。自动保存可能失败；如仍可读取，请立即导出。';
      root.querySelector('[data-import]').disabled=true;
      open.textContent='本地存档 ⚠';
      open.title='本地存储不可写，自动保存可能失败；点击查看或导出备份';
    }
  }
  availability();
  function close() { panel.hidden=true; open.setAttribute('aria-expanded','false'); open.focus(); }
  open.onclick=()=>{ panel.hidden=!panel.hidden; open.setAttribute('aria-expanded',String(!panel.hidden)); if (!panel.hidden) availability(); };
  root.querySelector('[data-close]').onclick=close;
  root.addEventListener('keydown',event=>{ event.stopPropagation(); if (event.key==='Escape' && !panel.hidden) close(); });
  root.querySelector('[data-export]').onclick=()=>{ try { download(collectBackup(window.localStorage)); status.textContent='已请求下载备份，请确认文件已保存。'; } catch(error) { status.textContent='导出失败：'+error.message; } };
  root.querySelector('[data-import]').onclick=()=>{ input.value=''; input.click(); };
  input.onchange=async()=>{
    const file=input.files?.[0]; if (!file) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) fail('备份文件超过 24 MB');
      const backup=validateBackup(JSON.parse(await file.text()));
      if (!window.confirm('导入将替换所有本游戏的本地记录（备份中缺少的记录也会删除）。将先下载恢复前备份。请先退出正在进行的比赛。继续？')) return;
      download(collectBackup(window.localStorage),'-before-restore');
      if (!window.confirm('请确认“恢复前备份”已保存到磁盘，再继续覆盖。无法确认下载成功时请取消。')) return;
      restoreBackup(window.localStorage,backup); status.textContent='恢复成功，正在刷新以加载记录……'; window.location.reload();
    } catch(error) { status.textContent='导入失败：'+error.message; }
  };
}
