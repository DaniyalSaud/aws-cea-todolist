import { mkdir, writeFile } from 'node:fs/promises';

const directory = new URL('../certs/', import.meta.url);
const response = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem');
if (!response.ok) throw new Error(`Unable to download RDS CA bundle: HTTP ${response.status}`);
const bundle = await response.text();
if (!bundle.includes('-----BEGIN CERTIFICATE-----')) throw new Error('Invalid RDS CA bundle.');
await mkdir(directory, { recursive: true });
await writeFile(new URL('global-bundle.pem', directory), bundle);
console.log('Downloaded certs/global-bundle.pem from the AWS RDS trust store.');
