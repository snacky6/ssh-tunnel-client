 <div align="center" width="100%">
    <img src="assets/ssh-tunnel-client.png" width="128"/>
</div>

# ssh-tunnel-client

A lightweight **SSH tunnel client** that forwards a local port to a service reachable from a remote SSH tunnel server. Supports public-key and private-key authentication.

Built with [`ssh2`](https://github.com/mscdex/ssh2), [`commander`](https://github.com/tj/commander.js), and [`chalk`](https://github.com/chalk/chalk). No system SSH client is required at runtime. Runs on Windows, Linux, and macOS.

![Client Version](https://img.shields.io/badge/client-v1.0.0-blue.svg) ![Server Version](https://img.shields.io/docker/v/snacky6/ssh-tunnel-server?label=server) ![Node Version](https://img.shields.io/badge/node-%3E=22-green)

## Table of Contents

- [Quick start](#quick-start)
  - [1. Generate SSH keys](#1-generate-ssh-keys)
  - [2. Set up the server](#2-set-up-the-server)
  - [3. Set up the client](#3-set-up-the-client)
- [Installation](#installation)
- [Usage](#usage)
- [Examples](#examples)
- [Behaviour notes](#behaviour-notes)

## Quick start

**Requirements:** Node.js 22.x or newer.

### 1. Generate SSH keys

Generate a key pair for the server:

```bash
ssh-keygen -t ed25519 -f /tmp/host_key -N ""
```

Generate a key pair for the client:

```bash
ssh-keygen -t ed25519 -C "<YOUR_NAME>" -f /tmp/id_tunnel -N ""
```

Keep private keys private. The server private key belongs on the server and the client private key belongs on the client.

### 2. Set up the server

Create the server directory and its keys directory:

```bash
mkdir -p ssh-tunnel-server/keys
cd ssh-tunnel-server
touch keys/authorized_keys
```

Copy the server private key and client public key to the server:

```bash
# Run on the client
scp /tmp/host_key user@server:/home/user/ssh-tunnel-server/keys/
scp /tmp/id_tunnel.pub user@server:/home/user/ssh-tunnel-server/keys/
```

Add the client's public key to the authorized keys file, then remove the copied public key:

```bash
# Run on the server
cat keys/id_tunnel.pub >> keys/authorized_keys
rm keys/id_tunnel.pub
```

Create `ssh-tunnel-server/config.json`:

```json
{
  "listeningHost": "0.0.0.0",
  "listeningPort": 2209,
  "allowedClientIPs": ["*"],
  "allowedTargetPorts": ["*"]
}
```

Create `ssh-tunnel-server/docker-compose.yml`:

```yaml
services:
  ssh-tunnel-server:
    image: snacky6/ssh-tunnel-server:1.0.0
    restart: unless-stopped
    volumes:
      - ./config.json:/app/config.json:ro
      - ./keys:/app/keys:ro
    network_mode: host
```

Start the server:

```bash
# Run in the foreground
docker compose up

# Or run in the background
docker compose up -d
```

### 3. Set up the client

Clone the repository and install dependencies:

```bash
git clone git@github.com:snacky6/ssh-tunnel-client.git
cd ssh-tunnel-client
npm install
npm link
```

Move the client key pair into the client's `keys` directory:

```bash
mv /tmp/id_tunnel /tmp/id_tunnel.pub keys/
```

Remove the server key pair from the client machine:

```bash
rm /tmp/host_key /tmp/host_key.pub
```

Start a tunnel to the service on port `8080`:

```bash
ssh-tunnel SERVER_IP 8080
```

The client prints the local address and port to use.

## Installation

From the repository root, install the dependencies:

```bash
npm install
```

To make the `ssh-tunnel` command available globally:

```bash
npm link
```

Alternatively, run the client directly:

```bash
node client/index.js SERVER_IP TARGET_PORT
```

## Usage

```bash
ssh-tunnel [OPTIONS] SERVER_IP TARGET_PORT
```

| Argument      | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `SERVER_IP`   | IP address or hostname of the remote SSH tunnel server.      |
| `TARGET_PORT` | The port of the service you want to reach **on the server**. |

| Option                      | Description                                                               |
| --------------------------- | ------------------------------------------------------------------------- |
| `-i, --identity <path>`     | Path to the private key file. Defaults to standard locations (see below)  |
| `-p, --port <number>`       | SSH server listening port (default `2209`)                                |
| `-l, --local-port <number>` | Local port to bind (default: a random port **> 10000**)                   |
| `-v, --version`             | Print client version information                                          |
| `-h, --help`                | Display the help menu                                                     |

By default, the client listens on a **random local port above `10000`** and prints the address. Use `-l` to specify a fixed port.

## Examples

```bash
# Forward remote port 8080 to a random local port
ssh-tunnel 35.126.52.31 8080

# Forward remote port 8080 to local port 12345
ssh-tunnel -l 12345 35.126.52.31 8080

# Use a specific client private key
ssh-tunnel -i ~/.ssh/private_key.pem 35.126.52.31 8080

# Connect to the SSH server on a non-default port
ssh-tunnel -p 4418 35.126.52.31 8080
```

When `-i` is omitted, the client searches for a private key in this order:

1. `./private_key.pem`
2. `./id_tunnel`
3. `./keys/id_tunnel`
4. `~/.ssh/id_ed25519`
5. `~/.ssh/id_rsa`

## Behaviour notes

- **Auto-reconnect:** If the SSH connection drops, the client retries with increasing delays. The local listener remains active.
- **Graceful shutdown:** Press `Ctrl+C` (`SIGINT`) to close the local listener and SSH session cleanly.
- **Public-key authentication only:** The client authenticates using its private key. The server rejects other authentication methods.