import http from 'node:http';

const server = http.createServer(async (req, res) => {
  console.log(`RECV: ${req.method} ${req.url}`);
  let body = '';
  for await (const chunk of req) body += chunk;
  console.log(`BODY: ${body.slice(0, 200)}`);
  
  try {
    const data = JSON.parse(body);
    console.log(`PARSED: type=${data.post_type} msg_type=${data.message_type} group=${data.group_id}`);
  } catch(e) {
    console.log(`PARSE ERROR: ${e.message}`);
  }
  
  res.writeHead(200);
  res.end('ok');
});

server.listen(16789, '127.0.0.1', () => console.log('Test server on 16789'));
