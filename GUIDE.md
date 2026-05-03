# Nginx Reverse Proxy And TLS Guide

This guide exposes the PM2 app to the internet through `nicerouter.mooo.com`.

Target architecture:

- 9router runs on the VPS with PM2 at `127.0.0.1:20128`
- Nginx listens on `80` and `443`
- Nginx proxies requests from `nicerouter.mooo.com` to the local app
- Certbot issues and renews the TLS certificate

## Recommended App Env

Use these values for the app on the server:

```bash
HOSTNAME=127.0.0.1
PORT=20128
NEXT_PUBLIC_BASE_URL=https://nicerouter.mooo.com
```

Notes:

- `HOSTNAME=127.0.0.1` keeps the app private behind Nginx
- public traffic comes in through Nginx, not directly to port `20128`

## Step 1: Create The HTTP Nginx Site

Create `/etc/nginx/sites-available/nicerouter.mooo.com`:

```bash
sudo tee /etc/nginx/sites-available/nicerouter.mooo.com >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name nicerouter.mooo.com;

    client_max_body_size 20m;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/javascript
        application/json
        application/xml
        application/rss+xml
        image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:20128;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        proxy_connect_timeout 60;

        proxy_buffering off;
    }

    location /_next/static/ {
        proxy_pass http://127.0.0.1:20128;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
    }
}
EOF
```

Enable the site:

```bash
sudo ln -sf /etc/nginx/sites-available/nicerouter.mooo.com /etc/nginx/sites-enabled/nicerouter.mooo.com
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## Step 2: Issue The TLS Certificate

Make sure DNS already points `nicerouter.mooo.com` to the VPS public IP, then run:

```bash
sudo certbot --nginx -d nicerouter.mooo.com
```

This will update the Nginx site and usually add the HTTPS server block plus HTTP to HTTPS redirect automatically.

Verify renewal:

```bash
sudo certbot renew --dry-run
```

## Step 3: What The Final HTTPS Config Should Look Like

After Certbot finishes, the Nginx config should effectively become this shape:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name nicerouter.mooo.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name nicerouter.mooo.com;

    ssl_certificate /etc/letsencrypt/live/nicerouter.mooo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nicerouter.mooo.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 20m;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/javascript
        application/json
        application/xml
        application/rss+xml
        image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:20128;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        proxy_connect_timeout 60;

        proxy_buffering off;
    }

    location /_next/static/ {
        proxy_pass http://127.0.0.1:20128;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
    }
}
```

If Certbot overwrites too much, re-open the site file and make sure the gzip and proxy settings above are still present.

## Step 4: Quick Checks

Check that the app is listening locally:

```bash
ss -ltnp | grep 20128
```

Check Nginx config:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Check the app through Nginx:

```bash
curl -I http://nicerouter.mooo.com
curl -I https://nicerouter.mooo.com
```

## Operational Notes

- Do not expose port `20128` publicly if Nginx is the public entrypoint
- `0.0.0.0:20128` still works, but `127.0.0.1:20128` is safer
- `proxy_buffering off` is useful if you have long-lived streaming responses
- gzip helps for HTML, JSON, JS, and CSS, but not for assets that are already compressed
- if Certbot fails, first check DNS, then port `80`, then `sudo nginx -t`
