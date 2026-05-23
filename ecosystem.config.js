/**
 * PM2 Ecosystem Configuration
 *
 * Start:  pm2 start ecosystem.config.js --env production
 * Stop:   pm2 stop all
 * Logs:   pm2 logs
 *
 * Cluster mode uses all available CPU cores on the VPS.
 */
module.exports = {
    apps: [
        {
            name: 'digital-platform-api',
            script: 'src/server.js',

            // ── Cluster mode — utilise all CPU cores ──────────────────────
            instances: 'max',
            exec_mode: 'cluster',

            // ── Graceful restart settings ─────────────────────────────────
            watch: false,
            max_memory_restart: '512M',
            kill_timeout: 5000,
            wait_ready: true,
            listen_timeout: 10000,

            // ── Logging ──────────────────────────────────────────────────
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: './logs/pm2-error.log',
            out_file: './logs/pm2-out.log',
            merge_logs: true,

            // ── Environment Variables ─────────────────────────────────────
            env: {
                NODE_ENV: 'development',
            },
            env_production: {
                NODE_ENV: 'production',
            },
        },
    ],
};
