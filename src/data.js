export function filterRows(rows,{q='',start='',end='',code=''}) {
 return rows.filter(r=>(!q||(r.ticker+' '+r.company_name).toLowerCase().includes(q.toLowerCase()))&&(!start||r.filing_date>=start)&&(!end||r.filing_date<=end)&&(!code||r.transaction_code===code)).sort((a,b)=>b.filing_date.localeCompare(a.filing_date));
}
const SORTS={newest:(a,b)=>b.filing_date.localeCompare(a.filing_date),oldest:(a,b)=>a.filing_date.localeCompare(b.filing_date),value:(a,b)=>(b.transaction_value??-Infinity)-(a.transaction_value??-Infinity)};
// Stable: ties keep the newest-first order from filterRows. `scoreOf` supplies the rule score for 'score'.
export function sortRows(rows,sort='newest',scoreOf=()=>0){const by=sort==='score'?(a,b)=>scoreOf(b)-scoreOf(a):SORTS[sort]||SORTS.newest;return [...rows].sort(by);}
export const displayNumber=(v,currency=false)=>v==null?'Not reported':new Intl.NumberFormat('en-US',{maximumFractionDigits:2,...(currency?{style:'currency',currency:'USD'}:{})}).format(v);
export function filingURL(url) {try {const p=new URL(url);return p.protocol==='https:'&&p.hostname==='www.sec.gov'&&p.pathname.startsWith('/Archives/edgar/data/')?p.href:null;}catch{return null;}}
export const escapeHTML=v=>String(v??'Not reported').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
