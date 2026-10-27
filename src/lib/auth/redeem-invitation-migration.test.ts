import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(process.cwd(), "supabase", "migrations");

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }));

const tablesWithoutDomainData = new Set([
  "profiles",
  "account_invitations",
  "member_presence",
  "pending_message_statuses",
]);

function accountScopedTables(): Set<string> {
  const tables = new Set<string>();
  const accountForeignKey = /\baccount_id\s+uuid\b[^,;]*references\s+(?:public\.)?accounts\s*\(\s*id\s*\)/i;
  const tableName = /(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table)\s+(?:public\.)?(\w+)/i;
  for (const { sql } of migrations) {
    for (const statement of sql.split(";")) {
      if (!accountForeignKey.test(statement)) continue;
      const match = statement.match(tableName);
      if (match) tables.add(match[1].toLowerCase());
    }
  }
  return tables;
}

function latestFunctionBody(functionName: string): string {
  const header = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`, "i");
  const latest = migrations.filter(({ sql }) => header.test(sql)).at(-1);
  if (!latest) throw new Error(`${functionName} is not defined in any migration`);
  const start = latest.sql.search(header);
  const bodyStart = latest.sql.indexOf("$$", start);
  const bodyEnd = latest.sql.indexOf("$$", bodyStart + 2);
  return latest.sql.slice(bodyStart + 2, bodyEnd);
}

describe("redeem_invitation migration", () => {
  const body = latestFunctionBody("redeem_invitation");

  it("finds the account-scoped tables it is meant to guard", () => {
    const tables = accountScopedTables();
    expect(tables).toContain("contacts");
    expect(tables).toContain("api_keys");
    expect(tables).toContain("quick_replies");
  });

  it("checks every account-scoped table for data before deleting the old account", () => {
    const missing = [...accountScopedTables()]
      .filter((table) => !tablesWithoutDomainData.has(table))
      .filter((table) => !new RegExp(`from\\s+${table}\\s+where\\s+account_id\\s*=\\s*v_old_account_id`, "i").test(body));
    expect(missing).toEqual([]);
  });

  it("refuses when the old account has other members", () => {
    expect(body).toMatch(/from\s+profiles\s+where\s+account_id\s*=\s*v_old_account_id\s+and\s+user_id\s*<>\s*v_caller_id/i);
  });
});

describe("never-expiring invitations (migration 057)", () => {
  const redeem = latestFunctionBody("redeem_invitation");
  const peek = latestFunctionBody("peek_invitation");
  const explicitExpiry = /if\s+v_inv\.expires_at\s+is\s+not\s+null\s+and\s+v_inv\.expires_at\s*<=\s*now\(\)/i;

  it("makes expires_at nullable without touching existing rows", () => {
    const sql = migrations.find(({ name }) => name.startsWith("057_"))!.sql;
    const outsideFunctions = sql.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(outsideFunctions).toMatch(/alter\s+table\s+account_invitations\s+alter\s+column\s+expires_at\s+drop\s+not\s+null/i);
    expect(outsideFunctions).not.toMatch(/\b(update|delete\s+from|truncate)\s+account_invitations\b/i);
  });

  it("both RPCs treat NULL as no time limit and still reject past timestamps", () => {
    expect(peek).toMatch(explicitExpiry);
    expect(redeem).toMatch(explicitExpiry);
    expect(peek).toMatch(/'reason',\s*'expired'/);
    expect(redeem).toMatch(/Invitation has expired/);
  });

  it("redeem stays single-use: used links are refused before the expiry check and marked accepted", () => {
    const usedCheck = redeem.search(/if\s+v_inv\.accepted_at\s+is\s+not\s+null/i);
    expect(usedCheck).toBeGreaterThan(-1);
    expect(usedCheck).toBeLessThan(redeem.search(explicitExpiry));
    expect(redeem).toMatch(/for\s+update/i);
    expect(redeem).toMatch(/set\s+accepted_at\s*=\s*now\(\)/i);
    expect(peek).toMatch(/'reason',\s*'used'/);
  });

  it("redeem is otherwise identical to migration 047", () => {
    const m047 = migrations.find(({ name }) => name.startsWith("047_"))!.sql;
    const start = m047.search(/create\s+or\s+replace\s+function\s+public\.redeem_invitation\s*\(/i);
    const bodyStart = m047.indexOf("$$", start);
    const previous = m047.slice(bodyStart + 2, m047.indexOf("$$", bodyStart + 2));
    const normalize = (s: string) =>
      s.replace(/v_inv\.expires_at\s+is\s+not\s+null\s+and\s+/i, "").replace(/\s+/g, " ").trim();
    expect(normalize(redeem)).toBe(normalize(previous));
  });
});

describe("member RPC migrations", () => {
  it.each(["set_member_role", "remove_account_member", "transfer_account_ownership"])(
    "%s locks the caller and target profiles in user_id order",
    (functionName) => {
      expect(latestFunctionBody(functionName)).toMatch(
        /from\s+profiles\s+where\s+user_id\s+in\s*\(\s*auth\.uid\(\),\s*p_\w+\s*\)\s+order\s+by\s+user_id\s+for\s+update/i,
      );
    },
  );
});
