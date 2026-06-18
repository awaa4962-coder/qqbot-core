import http from 'node:http';
import fs from 'node:fs';

let inbox = [];
const FILE = 'C:/Users/asus/.openclaw/workspace/qqfriend/napcat_inbox.json';
try { inbox = JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch {}

function isAtMe(msg) {
  return msg && msg.some && msg.some(s => s.type === 'at' && String(s.data.qq) === '3793063700');
}

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  console.log('REQ:', req.method, req.url, 'BODY:', body.slice(0, 300));
  try {
    if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({inbox:inbox.length})); return; }
    const ev = JSON.parse(body);
    if (ev.post_type === 'message' && ev.message_type === 'group' && ev.group_id === 1105126214) {
      if (isAtMe(ev.message)) {
        inbox.push({time:Date.now(), user_id:ev.sender.user_id, nickname:ev.sender.nickname, replied:false});
        fs.writeFileSync(FILE, JSON.stringify(inbox, null, 2), 'utf-8');
        console.log('SAVED to inbox, count:', inbox.length);
      }
    }
    res.writeHead(200); res.end('{}');
  } catch(e) { console.log('ERR:', e.message); res.writeHead(500); res.end(e.message); }
});
server.listen(16789, '127.0.0.1', () => console.log('Debug ready on 16789'));
