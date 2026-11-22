#!/usr/bin/env node
'use strict';

// Bootstrap or repair the first administrator without exposing public
// self-registration. Usage:
//   ADMIN_PASSWORD='strong-pass' node scripts/create-admin.js --login admin --name "Админ"
// The password can also be passed as --password (visible in shell history/ps).

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
let Store;
try {
  ({ Store } = require('../src/store'));
} catch {
  ({ Store } = require('../services/app/src/store'));
}

const scrypt = promisify(crypto.scrypt);

function arg(name, fallback = '') {
  const index = process.argv.indexOf('--' + name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const prefixed = process.argv.find(item => item.startsWith('--' + name + '='));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
}

async function main() {
  const login = String(arg('login', process.env.ADMIN_LOGIN || '')).trim();
  const name = String(arg('name', process.env.ADMIN_NAME || 'Администратор')).trim();
  const password = String(arg('password', process.env.ADMIN_PASSWORD || ''));
  if (!login || login.length > 128) throw new Error('Укажите --login (до 128 символов)');
  if (!name || name.length > 200) throw new Error('Укажите --name (до 200 символов)');
  if (password.length < 8) throw new Error('Пароль должен содержать не менее 8 символов');

  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '.data'));
  const store = new Store(dataDir);
  try {
    const existing = store.getUserByLogin(login.toLowerCase());
    if (existing) {
      store.setUserRole(existing.id, 'admin');
      console.log(`Пользователь ${existing.login} уже существует; роль admin подтверждена.`);
      return;
    }
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    store.createUser({
      id: crypto.randomUUID(),
      name,
      login,
      loginNormalized: login.toLowerCase(),
      passwordHash: Buffer.from(hash).toString('base64'),
      passwordSalt: salt.toString('base64'),
      role: 'admin',
      createdAt: Date.now()
    });
    console.log(`Создан администратор ${login}. Регистрация пользователей через API не требуется.`);
  } finally {
    store.close();
  }
}

main().catch(error => {
  console.error('Ошибка:', error.message);
  process.exitCode = 1;
});
