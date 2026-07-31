import { isIP } from "node:net";

const WEB_HOST = "127.0.0.1";
const WEB_ORIGINS = ["localhost", WEB_HOST];

function usage(message) {
  if (message) {
    console.error(`seniman-meja: ${message}\n`);
  }
  console.error(
    "Usage: seniman-meja [transport-options] [-p web-port]\n" +
    "\n" +
    "Meja transport options:\n" +
    "  -L profile              select a named Meja server profile\n" +
    "  -S socket-path          select an exact Meja server socket\n" +
    "  -h, --host user@host    reach Meja through SSH\n" +
    "  -i identity-file        use an SSH identity file\n" +
    "  --ssh-port port         use an SSH port\n" +
    "  --remote-path path      remote Meja executable (default: meja)\n" +
    "\n" +
    "Web options:\n" +
    "  -p, --web-port port     localhost web port (default: 7045)\n" +
    "  --listen ip-address     listen on an additional local IP (repeatable)\n" +
    "  --allow-origin hostname allow an additional browser origin (repeatable)\n" +
    "  --skip-password         disable built-in web authentication (unsafe)\n" +
    "\n" +
    "Open /session/<id-or-name> to attach, or / to create a session."
  );
  process.exit(message ? 1 : 0);
}

function parsePositiveInteger(option, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) {
    usage(`${option} requires an integer between 1 and 65535`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    profile: "default",
    profileSet: false,
    socket: "",
    sshHost: "",
    identityFile: "",
    sshPort: 0,
    remotePath: "meja",
    listenHosts: [WEB_HOST],
    allowedOrigins: [...WEB_ORIGINS],
    skipPassword: false,
    port: 7045,
    cols: 80,
    rows: 20,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) {
        usage(`${argument} requires a value`);
      }
      return argv[index];
    };

    switch (argument) {
      case "-L":
        if (options.socket) {
          usage("-L and -S are mutually exclusive");
        }
        options.profile = value();
        options.profileSet = true;
        break;
      case "-S":
      case "--socket":
        if (options.profileSet) {
          usage("-L and -S are mutually exclusive");
        }
        options.socket = value();
        break;
      case "-h":
      case "--host":
        options.sshHost = value();
        break;
      case "-i":
        options.identityFile = value();
        break;
      case "--ssh-port":
        options.sshPort = parsePositiveInteger(argument, value());
        break;
      case "--remote-path":
        options.remotePath = value();
        break;
      case "--allow-origin": {
        const hostname = value().toLowerCase().replace(/\.$/, "");
        if (
          !hostname ||
          hostname.includes("/") ||
          hostname.includes(":") ||
          hostname.includes("@") ||
          hostname.includes("?") ||
          hostname.includes("#") ||
          !/^[a-z0-9.-]+$/.test(hostname)
        ) {
          usage(
            "--allow-origin requires a hostname without a scheme or port"
          );
        }
        if (!options.allowedOrigins.includes(hostname)) {
          options.allowedOrigins.push(hostname);
        }
        break;
      }
      case "--skip-password":
        options.skipPassword = true;
        break;
      case "--listen": {
        const address = value();
        if (
          isIP(address) === 0 ||
          address === "0.0.0.0" ||
          address === "::"
        ) {
          usage(
            "--listen requires a specific local IP address, not a wildcard"
          );
        }
        if (!options.listenHosts.includes(address)) {
          options.listenHosts.push(address);
        }
        break;
      }
      case "-p":
      case "--web-port":
      case "--port":
        options.port = parsePositiveInteger(argument, value());
        break;
      case "--cols":
        options.cols = parsePositiveInteger(argument, value());
        break;
      case "--rows":
        options.rows = parsePositiveInteger(argument, value());
        break;
      case "--help":
        usage();
        break;
      default:
        usage(`unknown option ${argument}`);
    }
  }
  if (options.socket && !options.socket.startsWith("/")) {
    usage("-S requires an absolute socket path");
  }
  if (
    !options.profile ||
    !/^[A-Za-z0-9._-]+$/.test(options.profile) ||
    options.profile === "." ||
    options.profile === ".."
  ) {
    usage("invalid -L profile");
  }
  if (!options.remotePath) {
    usage("--remote-path requires a non-empty value");
  }
  return options;
}
