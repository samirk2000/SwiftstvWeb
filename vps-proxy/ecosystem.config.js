/**
 * PM2 ecosystem — SwiftstvWeb stream proxy.
 *
 * Defaults to ONE instance (fork) which is right for a streaming proxy behind
 * Nginx. Bump `instances` + `exec_mode: 'cluster'` only if you need CPU scaling
 * (streaming is I/O-bound, so a single worker usually saturates one core).
 *
 * Usage:
 *   cd vps-proxy && npm i
 *   pm2 start ecosystem.config.js
 *   pm2 save          # persist across reboots
 *   pm2 startup       # run the printed command once to autostart on boot
 *   pm2 logs swift-stream-proxy
 */
module.exports = {
  apps: [
    {
      name: 'swift-stream-proxy',
      script: './proxy.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // ms to abort a hung upstream socket. 0 = disabled (rarely needed).
        UPSTREAM_TIMEOUT_MS: 0,
      },
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
      time: true,
      max_restarts: 10,
    },
  ],
};
