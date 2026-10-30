// Prints a fresh set of secrets in .env format. Usage: node infra/gen-keys.mjs > infra/.env
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
console.log(`POSTGRES_PASSWORD=${randomBytes(24).toString('base64url')}`);
console.log(`DATA_KEK=${randomBytes(32).toString('base64')}`);
console.log(`BLIND_INDEX_KEY=${randomBytes(32).toString('base64')}`);
console.log(`JWT_PRIVATE_KEY="${pem.trim().replace(/\n/g, '\\n')}"`);
console.log('CORS_ORIGINS=https://localhost');
console.log('REQUIRE_STAFF_MFA=true');
