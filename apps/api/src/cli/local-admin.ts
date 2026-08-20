import { ensureSchema } from "../db/client";
import {
  LocalAccountExistsError,
  LocalAccountNotFoundError,
  LocalAuthService,
  PasswordPolicyError,
} from "../services/auth/local-auth.service";

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function emailArgument(args: string[]): string {
  const index = args.indexOf("--email");
  const email = index >= 0 ? args[index + 1]?.trim() : "";
  if (!email) fail("--email is required");
  return email;
}

async function passwordFromStdin(): Promise<string> {
  const input = await Bun.stdin.text();
  if (input.length > 1_024) fail("password input is too large");
  return input.replace(/\r?\n$/, "");
}

const [command = "", ...args] = Bun.argv.slice(2);
const email = emailArgument(args);
ensureSchema();
const service = new LocalAuthService();

try {
  if (command === "status") {
    if (await service.hasAccount(email)) {
      console.log("present");
      process.exit(0);
    }
    console.log("missing");
    process.exit(3);
  }

  if (command === "create") {
    await service.bootstrap(email, await passwordFromStdin());
    console.log(`Created local administrator ${email.toLowerCase()}.`);
    process.exit(0);
  }

  if (command === "reset") {
    await service.resetPassword(email, await passwordFromStdin());
    console.log(`Reset password and revoked active sessions for ${email.toLowerCase()}.`);
    process.exit(0);
  }

  fail("expected status, create, or reset");
} catch (error) {
  if (error instanceof LocalAccountExistsError) {
    console.log(`Local administrator ${email.toLowerCase()} already exists; password unchanged.`);
    process.exit(0);
  }
  if (error instanceof LocalAccountNotFoundError) fail(error.message, 4);
  if (error instanceof PasswordPolicyError) fail(error.message, 2);
  throw error;
}
