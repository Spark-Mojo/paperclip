#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const [prefix, buildRoot, sourceSha, receiptPath] = process.argv.slice(2);
if (!prefix || !buildRoot || !/^[0-9a-f]{40}$/.test(sourceSha || "") || !receiptPath) throw new Error("usage: overlay-contract.mjs PREFIX BUILD_ROOT SOURCE_SHA RECEIPT");
const version = "2026.831.1";
const cliRoot = path.join(prefix, "lib/node_modules/paperclipai");
const cliManifest = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json")));
if (cliManifest.version !== version) throw new Error(`official CLI baseline version ${cliManifest.version} != ${version}`);
const req = createRequire(path.join(cliRoot, "package.json"));
const specs = [
  { name: "@paperclipai/shared", source: "packages/shared", dirs: ["dist"] },
  { name: "@paperclipai/db", source: "packages/db", dirs: ["dist"] },
  { name: "@paperclipai/server", source: "server", dirs: ["dist", "ui-dist", "skills"] },
];
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function packageRoot(name) {
  let p = req.resolve(name);
  while (p !== path.dirname(p)) {
    const manifest = path.join(p, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest)).name === name) return p;
    p = path.dirname(p);
  }
  throw new Error(`cannot resolve ${name} from official CLI`);
}
function files(root) {
  const out=[];
  function walk(dir) { for (const ent of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,ent.name); if(ent.isSymbolicLink()) throw new Error(`symlink forbidden: ${p}`); if(ent.isDirectory()) walk(p); else if(ent.isFile()) out.push(p); else throw new Error(`unsupported entry: ${p}`); } }
  walk(root); return out.sort();
}
const receipt={schema:1,sourceSha,baselineVersion:version,files:[]};
for (const spec of specs) {
  const target=packageRoot(spec.name);
  const manifest=path.join(target,"package.json");
  const before=fs.readFileSync(manifest);
  const pkg=JSON.parse(before);
  if(pkg.version!==version) throw new Error(`${spec.name} baseline version ${pkg.version} != ${version}`);
  for (const section of ["dependencies","optionalDependencies","peerDependencies"]) for (const [name,value] of Object.entries(pkg[section]||{})) {
    if (specs.some(x=>x.name===name) && value!==version) throw new Error(`${spec.name} dependency edge ${name}=${value} != ${version}`);
  }
  const expectedNested=path.join(cliRoot,"node_modules",...spec.name.split("/"));
  if(fs.realpathSync(target)!==fs.realpathSync(expectedNested)) throw new Error(`${spec.name} runtime root is not intended nested root`);
  for(const dir of spec.dirs) {
    const src=path.join(buildRoot,spec.source,dir);
    if(!fs.statSync(src).isDirectory()) throw new Error(`missing overlay directory: ${src}`);
    for(const file of files(src)) {
      const rel=path.relative(path.join(buildRoot,spec.source),file);
      if(rel.startsWith("..")||path.isAbsolute(rel)) throw new Error(`path traversal: ${file}`);
      const dest=path.join(target,rel); const old=fs.existsSync(dest)?{sha256:sha(dest),size:fs.statSync(dest).size,mode:fs.statSync(dest).mode&0o777}:null;
      fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(file,dest); fs.chmodSync(dest,fs.statSync(file).mode&0o777);
      receipt.files.push({package:spec.name,path:rel,old,new:{sha256:sha(dest),size:fs.statSync(dest).size,mode:fs.statSync(dest).mode&0o777}});
    }
  }
  if(!before.equals(fs.readFileSync(manifest))) throw new Error(`${spec.name} package manifest changed`);
}
const stamp=JSON.parse(fs.readFileSync(path.join(buildRoot,"server/dist/build-info.json")));
if(stamp.commit!==sourceSha) throw new Error(`server build provenance ${stamp.commit} != ${sourceSha}`);
if(!receipt.files.some(x=>x.package==="@paperclipai/server"&&x.path==="dist/vendor/paperclip-runner/bin/paperclip-runnerd")) throw new Error("runner missing from overlay");
if(!receipt.files.some(x=>x.package==="@paperclipai/server"&&x.path.startsWith("ui-dist/"))) throw new Error("UI missing from overlay");
if(!receipt.files.some(x=>x.package==="@paperclipai/db"&&x.path.startsWith("dist/migrations/"))) throw new Error("migrations missing from overlay");
fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+"\n",{mode:0o600});
