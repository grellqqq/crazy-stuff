// Dev launcher: starts an in-memory MongoDB and runs the game server wired to
// it, so local login/register works without a real database.
// Data is EPHEMERAL (reset on restart) — fine for local testing.
//   node tools/dev-with-db.mjs   (run the client separately with `npm run dev`)
import { MongoMemoryServer } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';

const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri();
console.log(`[dev-with-db] in-memory MongoDB ready: ${uri}`);

const server = spawn('npx', ['tsx', 'watch', 'src/index.ts'], {
  cwd: 'src/server',
  env: { ...process.env, MONGODB_URI: uri, PORT: '3000' },
  stdio: 'inherit',
  shell: true,
});

const shutdown = async () => {
  server.kill();
  await mongo.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', (code) => { mongo.stop().finally(() => process.exit(code ?? 0)); });
