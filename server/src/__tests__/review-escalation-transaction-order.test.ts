import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";
import { describe, expect, it } from "vitest";

// --- ts facade -------------------------------------------------------------
// typescript@7 (native port) ships no JS parser surface: its "." entry is a
// version-stub and every ./unstable/* subpath is an IPC client for the Go
// binary, so `import ts from "typescript"` cannot parse source text. `vite`
// IS a declared server devDependency (server/package.json, "vite": "^8.2.2")
// and re-exports rolldown's native oxc-backed `parseAst`, so we use that
// public, declared API rather than reaching into transitive packages.
// Adapter: re-shape the oxc ESTree AST into the TS-compiler node shape this
// suite was written against (field names, parent links, getStart/getText/
// getSourceFile), so the assertions below are unchanged.
const nodeProto = {
  getStart() { return this.start; },
  getEnd() { return this.end; },
  getText() { return this.__file.text.slice(this.start, this.end); },
  getSourceFile() { return this.__file; },
  getLineAndCharacterOfPosition(position) {
    const lines = this.__file.text.slice(0, position).split("\n");
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
  },
};

function isWrappedNode(value) {
  return value !== null && typeof value === "object" && value.__node === true;
}

function setParent(wrapped, parent) {
  if (isWrappedNode(wrapped)) {
    Object.defineProperty(wrapped, "parent", { value: parent, configurable: true });
  }
  return wrapped;
}

function wrapChild(raw, parent, file) {
  if (Array.isArray(raw)) {
    return raw.map((item) => setParent(wrapNode(item, file), parent));
  }
  return setParent(wrapNode(raw, file), parent);
}

function wrapNode(raw, file) {
  if (raw === null || raw === undefined || typeof raw !== "object") return raw;
  if (Array.isArray(raw)) return raw.map((item) => wrapNode(item, file));
  const node = Object.create(nodeProto);
  node.type = raw.type;
  node.start = raw.start;
  node.end = raw.end;
  node.__file = file;
  node.__node = true;
  switch (raw.type) {
    case "Identifier":
      node.text = raw.name;
      // oxc spans an Identifier together with its type annotation; TS getText() does not.
      node.getText = () => raw.name;
      break;
    case "MemberExpression":
      node.expression = wrapChild(raw.object, node, file);
      node.name = wrapChild(raw.property, node, file);
      node.computed = raw.computed === true;
      break;
    case "CallExpression":
      node.expression = wrapChild(raw.callee, node, file);
      node.arguments = wrapChild(raw.arguments, node, file);
      break;
    case "AwaitExpression":
      // ESTree names the operand `argument`; TS names it `expression`. Without this
      // mapping every node beneath an `await` (e.g. `await db.transaction(...)`) is
      // invisible to forEachChild, so transition sites inside awaited transactions
      // are silently missed.
      node.expression = wrapChild(raw.argument, node, file);
      break;
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
      node.expression = wrapChild(raw.expression, node, file);
      break;
    case "VariableDeclarator":
      node.name = wrapChild(raw.id, node, file);
      node.initializer = wrapChild(raw.init, node, file);
      break;
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      // TS Parameter nodes carry `.name`; oxc params are the binding nodes themselves.
      node.parameters = (raw.params ?? []).map((param) => {
        const parameter = Object.create(nodeProto);
        parameter.type = "Parameter";
        parameter.start = param.start;
        parameter.end = param.end;
        parameter.__file = file;
        parameter.__node = true;
        parameter.name = wrapChild(param.type === "AssignmentPattern" ? param.left : param, parameter, file);
        return setParent(parameter, node);
      });
      node.body = wrapChild(raw.body, node, file);
      break;
    case "ObjectExpression":
      node.properties = wrapChild(raw.properties, node, file);
      break;
    case "Property":
      node.name = wrapChild(raw.key, node, file);
      node.initializer = wrapChild(raw.value, node, file);
      node.shorthand = raw.shorthand === true;
      break;
    case "ArrayPattern":
      node.elements = (raw.elements ?? []).map((element) => {
        if (element === null || element === undefined) return null;
        const binding = Object.create(nodeProto);
        binding.type = "BindingElement";
        binding.start = element.start;
        binding.end = element.end;
        binding.__file = file;
        binding.__node = true;
        binding.name = wrapChild(element, binding, file);
        return binding;
      });
      break;
    case "Program":
      node.statements = wrapChild(raw.body, node, file);
      break;
    default:
      for (const [key, value] of Object.entries(raw)) {
        if (key === "type" || key === "start" || key === "end") continue;
        node[key] = wrapChild(value, node, file);
      }
  }
  return node;
}

function createSourceFile(fileName, sourceText) {
  let program;
  try {
    program = parseAst(sourceText, { lang: "ts" }, fileName);
  } catch (error) {
    throw new Error(`vite parseAst failed to parse ${fileName}: ${(error as Error).message}`);
  }
  const file = Object.create(nodeProto);
  file.type = "SourceFile";
  file.fileName = fileName;
  file.text = sourceText;
  file.start = 0;
  file.end = sourceText.length;
  file.__file = file;
  file.__node = true;
  file.statements = wrapChild(program.body, file, file);
  Object.defineProperty(file, "parent", { value: null, configurable: true });
  return file;
}

const ts = {
  ScriptTarget: { Latest: 99 },
  createSourceFile,
  forEachChild(node, visit) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "__file") continue; // back-reference to the SourceFile, not a child
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isWrappedNode(item)) visit(item);
        }
      } else if (isWrappedNode(value)) {
        visit(value);
      }
    }
  },
  isCallExpression: (n) => n?.type === "CallExpression",
  isIdentifier: (n) => n?.type === "Identifier",
  isPropertyAccessExpression: (n) => n?.type === "MemberExpression" && n.computed === false,
  isArrowFunction: (n) => n?.type === "ArrowFunctionExpression",
  isFunctionExpression: (n) => n?.type === "FunctionExpression",
  isAwaitExpression: (n) => n?.type === "AwaitExpression",
  isParenthesizedExpression: (n) => n?.type === "ParenthesizedExpression",
  isAsExpression: (n) => n?.type === "TSAsExpression",
  isTypeAssertionExpression: (n) => n?.type === "TSTypeAssertion",
  isVariableDeclaration: (n) => n?.type === "VariableDeclarator",
  isArrayBindingPattern: (n) => n?.type === "ArrayPattern",
  isBindingElement: (n) => n?.type === "BindingElement",
  isObjectLiteralExpression: (n) => n?.type === "ObjectExpression",
  isShorthandPropertyAssignment: (n) => n?.type === "Property" && n.shorthand === true,
  isPropertyAssignment: (n) => n?.type === "Property" && n.shorthand === false,
};
// --- end ts facade ---------------------------------------------------------

// --- AST helpers -----------------------------------------------------------
function descendants<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function namedCall(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && (
    (ts.isIdentifier(node.expression) && node.expression.text === name) ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name)
  );
}

function transactionCallback(node: ts.Node): ts.ArrowFunction | ts.FunctionExpression | null {
  for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
    if (!ts.isArrowFunction(cursor) && !ts.isFunctionExpression(cursor)) continue;
    const call = cursor.parent;
    if (
      ts.isCallExpression(call) && call.arguments.includes(cursor) &&
      ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "transaction"
    ) return cursor;
  }
  return null;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
  ) current = current.expression;
  return current;
}

function bindingName(declaration: ts.VariableDeclaration): string | null {
  if (ts.isIdentifier(declaration.name)) return declaration.name.text;
  if (ts.isArrayBindingPattern(declaration.name)) {
    const first = declaration.name.elements[0];
    return first && ts.isBindingElement(first) && ts.isIdentifier(first.name) ? first.name.text : null;
  }
  return null;
}

function defaultLookupForTransition(call: ts.CallExpression, callback: ts.Node): ts.CallExpression | null {
  const file = call.getSourceFile();
  const input = call.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) return null;
  const property = input.properties.find((candidate) =>
    (ts.isShorthandPropertyAssignment(candidate) && candidate.name.text === "companyDefaultResponsibleUserId") ||
    (ts.isPropertyAssignment(candidate) && candidate.name.getText(file) === "companyDefaultResponsibleUserId")
  );
  if (!property) return null;
  const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  const direct = unwrap(value);
  if (namedCall(direct, "validatedCompanyDefaultResponsibleUserId")) return direct;
  if (!ts.isIdentifier(direct)) return null;
  const declaration = descendants(callback, ts.isVariableDeclaration).find((candidate) =>
    bindingName(candidate) === direct.text && candidate.getStart(file) < call.getStart(file)
  );
  if (!declaration?.initializer) return null;
  const initializer = unwrap(declaration.initializer);
  return namedCall(initializer, "validatedCompanyDefaultResponsibleUserId") ? initializer : null;
}

function usesTransactionHandle(expression: ts.Expression, callback: ts.ArrowFunction | ts.FunctionExpression) {
  const file = callback.getSourceFile();
  const txName = callback.parameters[0]?.name.getText(file);
  const value = unwrap(expression);
  if (ts.isIdentifier(value) && value.text === txName) return true;
  if (!ts.isIdentifier(value)) return false;
  const alias = descendants(callback, ts.isVariableDeclaration).find((declaration) =>
    bindingName(declaration) === value.text && declaration.initializer
  );
  return Boolean(alias?.initializer && unwrap(alias.initializer).getText(file) === txName);
}

function lockedIssueBefore(callback: ts.Node, lookup: ts.CallExpression) {
  const file = callback.getSourceFile();
  return descendants(callback, ts.isVariableDeclaration)
    .filter((declaration) => declaration.initializer && declaration.getStart(file) < lookup.getStart(file))
    .filter((declaration) => {
      const calls = descendants(declaration.initializer!, ts.isCallExpression);
      const locks = calls.some((node) => namedCall(node, "for") && node.arguments[0]?.getText(file) === '"update"');
      const readsIssueTable = calls.some((node) =>
        namedCall(node, "from") && ["issueRows", "issues"].includes(node.arguments[0]?.getText(file) ?? "")
      );
      return locks && readsIssueTable;
    })
    .at(-1) ?? null;
}

// --- ordering checker ------------------------------------------------------
type Violation = { code: string; detail: string };
type SiteDescription = {
  // Extra `<expr>.companyId` spellings, besides `<lockedRowBinding>.companyId`,
  // that are themselves derived from a row locked inside the same transaction.
  // Never `existing` / `currentIssue`: those are read before the lock.
  extraCompanyIdSources: string[];
};

const CODES = {
  notInTransaction: "transition-not-in-transaction",
  lookupMissing: "lookup-not-in-transaction",
  lookupNotAwaited: "lookup-not-awaited",
  wrongHandle: "lookup-not-using-tx-handle",
  noIssueLock: "no-issue-lock-before-lookup",
  staleCompanyId: "company-id-not-from-locked-row",
  staleIssueArgument: "transition-issue-not-locked-row",
} as const;

function objectPropertyValue(input: ts.Node, name: string): ts.Node | null {
  if (!ts.isObjectLiteralExpression(input)) return null;
  const file = input.getSourceFile();
  const property = input.properties.find((candidate) =>
    (ts.isShorthandPropertyAssignment(candidate) && candidate.name.text === name) ||
    (ts.isPropertyAssignment(candidate) && candidate.name.getText(file) === name)
  );
  if (!property) return null;
  return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
}

function isAwaited(call: ts.CallExpression): boolean {
  let cursor: ts.Node | undefined = call.parent;
  while (
    cursor && (ts.isParenthesizedExpression(cursor) || ts.isAsExpression(cursor) || ts.isTypeAssertionExpression(cursor))
  ) cursor = cursor.parent;
  return Boolean(cursor && ts.isAwaitExpression(cursor));
}

function checkTransitionSite(transition: ts.CallExpression, site: SiteDescription): Violation[] {
  const file = transition.getSourceFile();
  const violations: Violation[] = [];
  const callback = transactionCallback(transition);
  if (!callback) return [{ code: CODES.notInTransaction, detail: "transition must run inside db.transaction(...)" }];
  const lookup = defaultLookupForTransition(transition, callback);
  if (!lookup) return [{ code: CODES.lookupMissing, detail: "default must be obtained by a lookup inside that transaction" }];

  if (!isAwaited(lookup)) violations.push({ code: CODES.lookupNotAwaited, detail: "lookup must be awaited" });
  if (!usesTransactionHandle(lookup.arguments[0], callback)) {
    violations.push({ code: CODES.wrongHandle, detail: "lookup must use the transaction handle, not the outer db" });
  }
  const locked = lockedIssueBefore(callback, lookup);
  if (!locked) {
    violations.push({ code: CODES.noIssueLock, detail: "issue must be locked (.for(\"update\")) before the lookup" });
    return violations;
  }
  const lockedName = bindingName(locked);
  const allowedCompanyIds = [`${lockedName}.companyId`, ...site.extraCompanyIdSources];
  const companyIdText = lookup.arguments[1]?.getText(file) ?? "<missing>";
  if (!allowedCompanyIds.includes(companyIdText)) {
    violations.push({
      code: CODES.staleCompanyId,
      detail: `companyId argument \`${companyIdText}\` must be one of ${allowedCompanyIds.join(" | ")}`,
    });
  }
  const issueArgument = transition.arguments[0] && objectPropertyValue(transition.arguments[0], "issue");
  const issueArgumentText = issueArgument ? unwrap(issueArgument).getText(file) : "<missing>";
  if (issueArgumentText !== lockedName) {
    violations.push({
      code: CODES.staleIssueArgument,
      detail: `transition issue \`${issueArgumentText}\` must be the locked row \`${lockedName}\``,
    });
  }
  return violations;
}

function transitionsIn(sourceFile: ts.SourceFile): ts.CallExpression[] {
  return descendants(sourceFile, (node): node is ts.CallExpression => namedCall(node, "applyIssueExecutionPolicyTransition"));
}

function checkText(text: string, site: SiteDescription = { extraCompanyIdSources: [] }): string[] {
  const sites = transitionsIn(ts.createSourceFile("snippet.ts", text, ts.ScriptTarget.Latest, true));
  expect(sites, "snippet must contain exactly one transition call").toHaveLength(1);
  return checkTransitionSite(sites[0], site).map((violation) => violation.code);
}

// --- write-transaction locator ------------------------------------------------
// The PATCH /issues/:id handler computes a provisional transition in a short tx
// under the issue row lock. The write transaction
// (`issue = await db.transaction(async (tx) => { ... updateIssue(tx) ... })`)
// is located here only so a regression pin can assert what must NOT be in it.
function assignedToIssueVariable(call: ts.CallExpression): boolean {
  let cursor: ts.Node | undefined = call.parent;
  while (
    cursor && (ts.isAwaitExpression(cursor) || ts.isParenthesizedExpression(cursor) ||
      ts.isAsExpression(cursor) || ts.isTypeAssertionExpression(cursor))
  ) cursor = cursor.parent;
  if (!cursor) return false;
  if (cursor.type === "AssignmentExpression") {
    return ts.isIdentifier(cursor.left) && cursor.left.text === "issue";
  }
  if (ts.isVariableDeclaration(cursor)) return bindingName(cursor) === "issue";
  return false;
}

function writeTransactionsIn(sourceFile: ts.SourceFile): ts.CallExpression[] {
  return descendants(sourceFile, (node): node is ts.CallExpression => {
    if (!namedCall(node, "transaction") || !ts.isPropertyAccessExpression((node as ts.CallExpression).expression)) return false;
    const call = node as ts.CallExpression;
    const callback = call.arguments[0];
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return false;
    if (!assignedToIssueVariable(call)) return false;
    const txName = callback.parameters[0]?.name.getText(sourceFile);
    return descendants(callback, ts.isCallExpression).some((inner) =>
      namedCall(inner, "updateIssue") && inner.arguments[0]?.getText(sourceFile) === txName
    );
  });
}

// --- real source -----------------------------------------------------------
const sourcePaths = [
  fileURLToPath(new URL("../routes/issues.ts", import.meta.url)),
  fileURLToPath(new URL("../services/execution-workspaces.ts", import.meta.url)),
];
const sourceFiles = sourcePaths.map((sourcePath) =>
  ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true),
);
const realTransitions = sourceFiles.flatMap((sourceFile) =>
  transitionsIn(sourceFile).map((transition) => ({
    // Line numbers are diagnostics only; no assertion keys off them.
    label: `${sourceFile.fileName.split("/").slice(-2).join("/")}:${sourceFile.getLineAndCharacterOfPosition(transition.getStart()).line + 1}`,
    fileName: sourceFile.fileName,
    transition,
  })),
);

// --- site anchors -------------------------------------------------------------
// Sites are identified by CODE ANCHOR (route path string / unique identifier in the
// enclosing transaction callback / file), never by array length or line number.
const ROUTE_METHODS = ["get", "post", "put", "patch", "delete"];

// Path string of the nearest enclosing `router.<method>("/path", ...)` registration.
function enclosingRoutePath(node: ts.Node): string | null {
  for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
    if (!ts.isCallExpression(cursor) || !ts.isPropertyAccessExpression(cursor.expression)) continue;
    if (!ROUTE_METHODS.includes(cursor.expression.name.text)) continue;
    if (cursor.expression.expression.getText() !== "router") continue;
    const first = cursor.arguments[0]?.getText() ?? "";
    if (/^["'`]\/.*["'`]$/.test(first)) return first.slice(1, -1);
  }
  return null;
}

type RealTransition = (typeof realTransitions)[number];
type SiteAnchor = {
  name: string;
  matches: (entry: RealTransition) => boolean;
  site: SiteDescription;
};

const callbackTextOf = (entry: RealTransition) => transactionCallback(entry.transition)?.getText() ?? "";

// EXACTLY three in-transaction sites. (PATCH /issues/:id is deliberately NOT one of
// them: see the scope-documenting pin below.)
const inTransactionAnchors: SiteAnchor[] = [
  {
    name: "issues.ts POST /issues/:id/recovery-actions/resolve",
    matches: (entry) =>
      entry.fileName.endsWith("routes/issues.ts") &&
      enclosingRoutePath(entry.transition) === "/issues/:id/recovery-actions/resolve",
    site: { extraCompanyIdSources: [] },
  },
  {
    name: "issues.ts POST /issues/:id/comments auto-approve (AutoApprovalIssueMissingError)",
    matches: (entry) =>
      entry.fileName.endsWith("routes/issues.ts") &&
      enclosingRoutePath(entry.transition) === "/issues/:id/comments" &&
      callbackTextOf(entry).includes("AutoApprovalIssueMissingError"),
    site: { extraCompanyIdSources: [] },
  },
  {
    name: "execution-workspaces.ts (lockedWorkspace)",
    matches: (entry) =>
      entry.fileName.endsWith("services/execution-workspaces.ts") && callbackTextOf(entry).includes("lockedWorkspace"),
    // The workspace site locks the source issue with eq(issues.companyId, lockedWorkspace.companyId),
    // so the locked workspace's companyId is the same locked-row-derived value.
    site: { extraCompanyIdSources: ["lockedWorkspace.companyId"] },
  },
];

// The PATCH /issues/:id transition: the one whose requestedAssigneePatch is built
// from `normalizedAssigneeAgentId`.
function isPatchIssueTransition(transition: ts.CallExpression): boolean {
  const input = transition.arguments[0];
  const patch = input && objectPropertyValue(input, "requestedAssigneePatch");
  return Boolean(patch && ts.isObjectLiteralExpression(patch) && patch.getText().includes("normalizedAssigneeAgentId"));
}

const patchTransitions = realTransitions.filter((entry) => isPatchIssueTransition(entry.transition));
const nonPatchTransitions = realTransitions.filter((entry) => !isPatchIssueTransition(entry.transition));
const anchoredSites = inTransactionAnchors.map((anchor) => ({
  anchor,
  entries: nonPatchTransitions.filter((entry) => anchor.matches(entry)),
}));
const unanchoredTransitions = nonPatchTransitions.filter(
  (entry) => !inTransactionAnchors.some((anchor) => anchor.matches(entry)),
);

// --- PATCH /issues/:id scope pin (site b) ------------------------------------------
function enclosingHandler(node: ts.Node): ts.Node | null {
  for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
    const isFunction =
      ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor) || cursor.type === "FunctionDeclaration";
    if (!isFunction) continue;
    const parent = cursor.parent;
    const isTransactionCallback =
      parent && ts.isCallExpression(parent) && parent.arguments.includes(cursor) &&
      ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "transaction";
    if (!isTransactionCallback) return cursor;
  }
  return null;
}

// Documents the DELIBERATE narrower contract for PATCH /issues/:id: the company
// default is read through the OUTER handle, awaited, BEFORE the transition, and the
// transition is NOT inside a db.transaction callback.
function checkPatchIssueSite(transition: ts.CallExpression): string[] {
  const problems: string[] = [];
  if (transactionCallback(transition)) {
    problems.push("PATCH transition must NOT run inside a db.transaction(...) callback (no short tx; run-stop side effects run before the write tx)");
  }
  const handler = enclosingHandler(transition);
  const lookup = handler && defaultLookupForTransition(transition, handler);
  if (!lookup) return [...problems, "default must come from a validatedCompanyDefaultResponsibleUserId(...) lookup in the handler"];
  if (transactionCallback(lookup)) problems.push("default lookup must not be inside a db.transaction(...) callback");
  if (!isAwaited(lookup)) problems.push("default lookup must be awaited");
  if (lookup.arguments[0]?.getText() !== "db") problems.push("default lookup must use the outer `db` handle");
  if (lookup.arguments[1]?.getText() !== "existing.companyId") {
    problems.push("default lookup must be scoped by `existing.companyId`");
  }
  if (lookup.getStart() >= transition.getStart()) problems.push("default lookup must come BEFORE the transition");
  return problems;
}

// --- snippets --------------------------------------------------------------
type SnippetOptions = {
  lookupPlacement?: "after-lock" | "before-lock" | "outside-transaction";
  handle?: string;
  companyIdSource?: string;
  awaitLookup?: boolean;
  issueArgument?: string;
};

function snippet(options: SnippetOptions = {}): string {
  const {
    lookupPlacement = "after-lock",
    handle = "tx",
    companyIdSource = "lockedIssue.companyId",
    awaitLookup = true,
    issueArgument = "lockedIssue",
  } = options;
  const lookup = `const companyDefaultResponsibleUserId = ${awaitLookup ? "await " : ""}validatedCompanyDefaultResponsibleUserId(${handle}, ${companyIdSource});`;
  return `
    async function run(db, existing) {
      ${lookupPlacement === "outside-transaction" ? lookup : ""}
      return db.transaction(async (tx) => {
        ${lookupPlacement === "before-lock" ? lookup : ""}
        const lockedIssue = await tx
          .select()
          .from(issueRows)
          .where(and(eq(issueRows.companyId, existing.companyId), eq(issueRows.id, existing.id)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        ${lookupPlacement === "after-lock" ? lookup : ""}
        const transition = applyIssueExecutionPolicyTransition({
          issue: ${issueArgument},
          policy,
          companyDefaultResponsibleUserId,
          requestedStatus: "done",
        });
        return transition;
      });
    }
  `;
}

const realWriteTransactions = sourceFiles.flatMap((sourceFile) => writeTransactionsIn(sourceFile));

describe("review escalation default transaction ordering", () => {
  it("every non-PATCH transition sits in exactly one expected anchor (an unexpected or moved site fails loudly)", () => {
    expect(
      unanchoredTransitions.map((entry) => entry.label),
      "applyIssueExecutionPolicyTransition call found outside the expected anchors " +
        "(recovery-resolve route, comments auto-approve, execution-workspaces lockedWorkspace). " +
        "Add an anchor + ordering coverage for it, or move it back.",
    ).toEqual([]);
  });

  it("covers exactly THREE in-transaction sites, one per anchor (mutation control: a dropped or duplicated site cannot pass vacuously)", () => {
    expect(
      anchoredSites.map(({ anchor, entries }) => `${anchor.name}: ${entries.length}`),
    ).toEqual(inTransactionAnchors.map((anchor) => `${anchor.name}: 1`));
    expect(nonPatchTransitions).toHaveLength(3);
    // all three are really inside a transaction callback
    expect(nonPatchTransitions.filter((entry) => !transactionCallback(entry.transition)).map((entry) => entry.label)).toEqual([]);
  });

  it("finds exactly one PATCH /issues/:id transition (requestedAssigneePatch built from normalizedAssigneeAgentId)", () => {
    expect(patchTransitions.map((entry) => entry.label)).toHaveLength(1);
    expect(patchTransitions[0].fileName.endsWith("routes/issues.ts")).toBe(true);
    expect(enclosingRoutePath(patchTransitions[0].transition)).toBe("/issues/:id");
  });

  it("PATCH /issues/:id keeps its DELIBERATE narrower contract: default read via outer `db`, awaited, BEFORE a transition that is NOT inside any db.transaction", () => {
    // SCOPE-DOCUMENTING PIN (DECISION-139). PATCH /issues/:id intentionally does NOT
    // claim stale-snapshot atomicity for the company default: the lookup goes through
    // the outer handle before the transition, and the transition is not under a
    // transaction/row lock. Reasons: a short tx around the transition releases its
    // lock before the write tx, so it would not close the stale-snapshot gap anyway,
    // and the run-stop side effects must run before the write tx. A single-tx
    // restructure of PATCH is a FOLLOW-UP card. If you change this on purpose, update
    // this pin knowingly — do not just make it green.
    expect(patchTransitions).toHaveLength(1);
    expect(checkPatchIssueSite(patchTransitions[0].transition)).toEqual([]);
  });

  it("finds exactly one PATCH /issues/:id write transaction (`issue = await db.transaction(... updateIssue(tx) ...)`)", () => {
    expect(realWriteTransactions).toHaveLength(1);
    expect(realWriteTransactions[0].getSourceFile().fileName.endsWith("routes/issues.ts")).toBe(true);
  });

  it("does NOT re-derive the transition inside the PATCH /issues/:id write transaction (regression pin: no late 409 after irreversible run-stop side effects)", () => {
    // WHY: PATCH /issues/:id executes irreversible run-stop side effects
    // (heartbeat.cancelRun etc.) BEFORE the write transaction opens. If the write
    // tx re-derived the transition and threw a 409 on a material difference, the
    // run would already be cancelled while the issue stayed unchanged. The
    // provisional transition is therefore computed once, before the write tx
    // (see the PATCH scope pin above); the write tx must not call
    // executionTransitionMaterialDifference or applyIssueExecutionPolicyTransition.
    expect(realWriteTransactions).toHaveLength(1);
    const callback = realWriteTransactions[0].arguments[0] as ts.ArrowFunction | ts.FunctionExpression;
    const forbidden = ["executionTransitionMaterialDifference", "applyIssueExecutionPolicyTransition"];
    const found = descendants(callback, ts.isCallExpression)
      .filter((call) => forbidden.some((name) => namedCall(call, name)))
      .map((call) => `${call.expression.getText(call.getSourceFile())} @ line ${call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1}`);
    expect(found).toEqual([]);
  });

  it.each(inTransactionAnchors.map((anchor) => [anchor.name, anchor] as const))(
    "%s obtains its default through the transaction, awaited, after the locked issue read",
    (_name, anchor) => {
      const entries = nonPatchTransitions.filter((entry) => anchor.matches(entry));
      expect(entries, `expected exactly one transition at anchor "${anchor.name}"`).toHaveLength(1);
      const violations = checkTransitionSite(entries[0].transition, anchor.site).map((v) => `${v.code}: ${v.detail}`);
      expect(violations).toEqual([]);
    },
  );
});

describe("review escalation ordering checker discriminates (DB-free negative fixtures)", () => {
  it("accepts a correct site", () => {
    expect(checkText(snippet())).toEqual([]);
  });

  it("accepts the workspace-style locked-row-derived companyId only when the site declares it", () => {
    const text = snippet({ companyIdSource: "lockedWorkspace.companyId" });
    expect(checkText(text, { extraCompanyIdSources: ["lockedWorkspace.companyId"] })).toEqual([]);
    expect(checkText(text)).toEqual([CODES.staleCompanyId]);
  });

  it("rejects (a) a lookup placed before the issue lock inside the transaction", () => {
    expect(checkText(snippet({ lookupPlacement: "before-lock" }))).toEqual([CODES.noIssueLock]);
  });

  it("rejects (b) a lookup using the outer db handle instead of the tx handle", () => {
    expect(checkText(snippet({ handle: "db" }))).toEqual([CODES.wrongHandle]);
  });

  it("rejects (c) a companyId taken from a stale pre-lock row", () => {
    expect(checkText(snippet({ companyIdSource: "existing.companyId" }))).toEqual([CODES.staleCompanyId]);
    expect(checkText(snippet({ companyIdSource: "currentIssue.companyId" }))).toEqual([CODES.staleCompanyId]);
  });

  it("rejects (d) a lookup without await", () => {
    expect(checkText(snippet({ awaitLookup: false }))).toEqual([CODES.lookupNotAwaited]);
  });

  it("rejects (e) a lookup left outside the transaction", () => {
    expect(checkText(snippet({ lookupPlacement: "outside-transaction", handle: "db", companyIdSource: "existing.companyId" })))
      .toEqual([CODES.lookupMissing]);
  });

  it("rejects (f) a transition fed the stale pre-lock issue instead of the locked row", () => {
    expect(checkText(snippet({ issueArgument: "existing" }))).toEqual([CODES.staleIssueArgument]);
    expect(checkText(snippet({ issueArgument: "currentIssue" }))).toEqual([CODES.staleIssueArgument]);
  });

  it("rejects (g) a transition that is not inside a transaction at all", () => {
    const text = `
      async function run(db, existing) {
        const companyDefaultResponsibleUserId = await validatedCompanyDefaultResponsibleUserId(db, existing.companyId);
        return applyIssueExecutionPolicyTransition({ issue: existing, policy, companyDefaultResponsibleUserId });
      }
    `;
    expect(checkText(text)).toEqual([CODES.notInTransaction]);
  });
});

describe("PATCH scope pin checker discriminates (DB-free fixtures)", () => {
  const transitionCall = `applyIssueExecutionPolicyTransition({
    issue: existing,
    policy,
    companyDefaultResponsibleUserId,
    requestedAssigneePatch: { assigneeAgentId: normalizedAssigneeAgentId },
  })`;
  const problemsFor = (text: string) => {
    const file = ts.createSourceFile("snippet.ts", text, ts.ScriptTarget.Latest, true);
    const calls = transitionsIn(file);
    expect(calls).toHaveLength(1);
    expect(isPatchIssueTransition(calls[0])).toBe(true);
    return checkPatchIssueSite(calls[0]);
  };

  it("accepts an awaited outer-db lookup before a transition outside any transaction", () => {
    expect(problemsFor(`
      router.patch("/issues/:id", async (req, res) => {
        const companyDefaultResponsibleUserId = await validatedCompanyDefaultResponsibleUserId(db, existing.companyId);
        const transition = ${transitionCall};
      });
    `)).toEqual([]);
  });

  it("rejects a transition wrapped in a short db.transaction (the reverted shape)", () => {
    const problems = problemsFor(`
      router.patch("/issues/:id", async (req, res) => {
        const transition = await db.transaction(async (tx) => {
          const companyDefaultResponsibleUserId = await validatedCompanyDefaultResponsibleUserId(tx, existing.companyId);
          return ${transitionCall};
        });
      });
    `);
    expect(problems.some((p) => p.includes("must NOT run inside a db.transaction"))).toBe(true);
  });

  it("rejects a non-awaited lookup, a tx-handle lookup, and a lookup after the transition", () => {
    expect(problemsFor(`
      router.patch("/issues/:id", async (req, res) => {
        const companyDefaultResponsibleUserId = validatedCompanyDefaultResponsibleUserId(db, existing.companyId);
        const transition = ${transitionCall};
      });
    `)).toEqual(["default lookup must be awaited"]);
    expect(problemsFor(`
      router.patch("/issues/:id", async (req, res) => {
        const companyDefaultResponsibleUserId = await validatedCompanyDefaultResponsibleUserId(tx, existing.companyId);
        const transition = ${transitionCall};
      });
    `)).toEqual(["default lookup must use the outer `db` handle"]);
  });
});

describe("PATCH write-transaction locator discriminates (DB-free negative fixture)", () => {
  it("ignores a transaction that is not assigned to `issue` (other transactions are not the write tx)", () => {
    const text = `
      async function run(db) {
        const other = await db.transaction(async (tx) => { return updateIssue(tx); });
        issue = await db.transaction(async (tx) => { return updateIssue(tx); });
      }
    `;
    expect(writeTransactionsIn(ts.createSourceFile("snippet.ts", text, ts.ScriptTarget.Latest, true))).toHaveLength(1);
  });
});
