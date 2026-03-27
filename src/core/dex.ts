import { execSync } from "child_process";

export function runCliJson(
  args: string,
  privateKey?: string,
  walletAddress?: string,
): any {
  const homeDir = walletAddress
    ? `/tmp/byreal-${walletAddress}-${Date.now()}`
    : process.env.HOME || "/root";
  const cmdArgs = args.includes("-o json") ? args : `${args} -o json`;

  try {
    if (privateKey && walletAddress) {
      execSync(
        `mkdir -p ${homeDir} && HOME=${homeDir} /usr/local/bin/byreal-cli wallet set --private-key ${privateKey} --non-interactive`,
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        },
      );
    }

    const raw = execSync(`HOME=${homeDir} /usr/local/bin/byreal-cli ${cmdArgs}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });

    const lines = raw.split("\n");
    const jsonLines = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.includes("]")) return false;
      if (!trimmed) return false;
      return true;
    });

    const cleanJson = jsonLines.join("\n").trim();
    const startIndex = cleanJson.indexOf("{");
    const startArrayIndex = cleanJson.indexOf("[");

    let finalJson = cleanJson;
    const effectiveStart =
      startIndex !== -1 &&
      (startArrayIndex === -1 || startIndex < startArrayIndex)
        ? startIndex
        : startArrayIndex;

    if (effectiveStart !== -1) {
      finalJson = cleanJson.substring(effectiveStart);
    }

    return JSON.parse(finalJson);
  } catch (e: any) {
    try {
      const errorMsg = e.stdout || e.stderr || e.message;
      const jsonMatch = errorMsg.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (parseErr) {}
    throw e;
  } finally {
    if (walletAddress) {
      try {
        execSync(`rm -rf ${homeDir}`, { stdio: "pipe" });
      } catch (rmErr) {}
    }
  }
}

export function runCliText(
  args: string,
  privateKey?: string,
  walletAddress?: string,
): string {
  const homeDir = walletAddress
    ? `/tmp/byreal-${walletAddress}-${Date.now()}`
    : process.env.HOME || "/root";

  try {
    if (privateKey && walletAddress) {
      execSync(
        `mkdir -p ${homeDir} && HOME=${homeDir} /usr/local/bin/byreal-cli wallet set --private-key ${privateKey} --non-interactive`,
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        },
      );
    }

    return execSync(`HOME=${homeDir} /usr/local/bin/byreal-cli ${args}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch (e: any) {
    throw e;
  } finally {
    if (walletAddress) {
      try {
        execSync(`rm -rf ${homeDir}`, { stdio: "pipe" });
      } catch (rmErr) {}
    }
  }
}

export function getMyPositions(
  privateKey?: string,
  walletAddress?: string,
): any[] {
  const allPos: any[] = [];
  let page = 1;
  const pageSize = 50;
  while (true) {
    try {
      const data = runCliJson(
        `positions list --page ${page} --page-size ${pageSize}`,
        privateKey,
        walletAddress,
      );
      const pos = data?.data?.positions ?? [];
      if (pos.length === 0) break;
      allPos.push(...pos);
      if (pos.length < pageSize) break;
      page++;
    } catch (e) {
      break;
    }
  }
  return allPos;
}
