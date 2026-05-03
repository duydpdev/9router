#!/bin/bash
set -euo pipefail

# ============================================================
# VPS Init Script - Debian 12 (64-bit)
# DigitalOcean Droplet
# Stack: nvm, Node 22, PM2, Nginx
# ============================================================

# --- CONFIG ---
APP_USER="duydpdev"
NODE_VERSION="22"
SWAP_SIZE="4G"

echo "=== [1/7] System Update & Essential Packages ==="
apt-get update && apt-get upgrade -y
apt-get install -y \
  curl wget git unzip htop \
  build-essential \
  ufw fail2ban \
  nginx \
  logrotate

# --- System Tuning ---
echo "=== [2/7] System Optimization ==="

# Swap
if [ ! -f /swapfile ]; then
  fallocate -l $SWAP_SIZE /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "vm.swappiness=10" >> /etc/sysctl.conf
  echo "vm.vfs_cache_pressure=50" >> /etc/sysctl.conf
fi

# Network & file descriptor tuning
if ! grep -q "# --- VPS Tuning ---" /etc/sysctl.conf; then
  cat >> /etc/sysctl.conf <<'SYSCTL'
# --- VPS Tuning ---
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_fastopen = 3
fs.file-max = 2097152
fs.inotify.max_user_watches = 524288
SYSCTL
fi
sysctl -p

# Raise file descriptor limits
if ! grep -q "nofile 65535" /etc/security/limits.conf; then
  cat >> /etc/security/limits.conf <<'LIMITS'
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
LIMITS
fi

# --- Firewall ---
echo "=== [3/7] Firewall (UFW) ==="
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# --- Fail2Ban ---
echo "=== [4/7] Fail2Ban ==="
cat > /etc/fail2ban/jail.local <<'F2B'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
F2B
systemctl enable fail2ban
systemctl restart fail2ban

# --- SSH Hardening ---
echo "=== [5/7] SSH Hardening ==="
sed -i 's/#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
systemctl restart sshd

# --- Deploy User + nvm + Node + PM2 ---
echo "=== [6/7] Deploy User, nvm, Node $NODE_VERSION, PM2 ==="
if ! id "$APP_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" $APP_USER
  usermod -aG sudo $APP_USER
  # Copy root SSH keys to deploy user
  mkdir -p /home/$APP_USER/.ssh
  cp /root/.ssh/authorized_keys /home/$APP_USER/.ssh/
  chown -R $APP_USER:$APP_USER /home/$APP_USER/.ssh
  chmod 700 /home/$APP_USER/.ssh
  chmod 600 /home/$APP_USER/.ssh/authorized_keys
fi

# Passwordless sudo (idempotent, needed for pm2 startup)
echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$APP_USER
chmod 440 /etc/sudoers.d/$APP_USER

# Install nvm + node + pm2 as deploy user
su - $APP_USER -c "
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  export NVM_DIR=\"\$HOME/.nvm\"
  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
  nvm install $NODE_VERSION
  nvm alias default $NODE_VERSION
  npm install -g pm2
"

# PM2 startup (run as root with correct PATH)
NODE_BIN=$(ls -d /home/$APP_USER/.nvm/versions/node/v${NODE_VERSION}*/bin 2>/dev/null | head -1)
env PATH="$NODE_BIN:$PATH" pm2 startup systemd -u $APP_USER --hp /home/$APP_USER

# --- Nginx Config ---
echo "=== [7/7] Nginx ==="

# Main nginx tuning
cat > /etc/nginx/nginx.conf <<'NGINX_MAIN'
user www-data;
worker_processes auto;
worker_rlimit_nofile 65535;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 4096;
    multi_accept on;
    use epoll;
}

http {
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    server_tokens off;
    client_max_body_size 50M;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Logging
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 4;
    gzip_min_length 256;
    gzip_types
        text/plain
        text/css
        text/javascript
        application/javascript
        application/json
        application/xml
        image/svg+xml
        font/woff2;

    # Security headers (default)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Rate limiting zone
    limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
NGINX_MAIN

rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
echo "Nginx installed. Site config & SSL — configure later."

# --- Logrotate for PM2 ---
cat > /etc/logrotate.d/pm2-$APP_USER <<LOGROTATE
/home/$APP_USER/.pm2/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGROTATE

# --- Summary ---
echo ""
echo "============================================"
echo "  VPS Init Complete!"
echo "============================================"
echo "  User:    $APP_USER"
echo "  Node:    v$NODE_VERSION (via nvm)"
echo "  PM2:     installed globally"
echo "  Nginx:   installed (no site config yet)"
echo "  UFW:     SSH + Nginx allowed"
echo "  Fail2Ban: active"
echo "  Swap:    $SWAP_SIZE"
echo ""
echo "  Next steps:"
echo "    1. ssh $APP_USER@<ip>"
echo "    2. Clone app, npm install, pm2 start"
echo "    3. Configure nginx site & SSL when ready"
echo "============================================"
