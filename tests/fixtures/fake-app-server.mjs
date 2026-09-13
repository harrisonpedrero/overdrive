let buffer = '';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
    else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-fixture' } } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-fixture' } } });
      send({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', delta: 'private' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', delta: 'visible' } });
    } else if (message.method === 'thread/read') send({ id: message.id, result: { thread: { id: 'thread-fixture', turns: [] } } });
    else send({ id: message.id, result: {} });
  }
});
