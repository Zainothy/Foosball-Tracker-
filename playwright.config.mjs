import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', use: { baseURL: 'http://127.0.0.1:5181', headless: true }, webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5181 --strictPort', url:'http://127.0.0.1:5181', reuseExistingServer:true }, reporter:'list' });
