import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const sections = ['Paperlight — third-party licenses\nGenerated from installed dependencies. Cargo includes build dependencies.\n'];
const missing = [];
const supplements = [
  [/^npm: @napi-rs\/canvas-/, 'node_modules/@napi-rs/canvas/LICENSE'],
  [/^Cargo: alloc-stdlib@0\.2\.4$/, 'scripts/licenses/alloc-stdlib.txt'],
  [/^Cargo: defmt-parser@1\.0\.0$/, 'scripts/licenses/defmt.txt'],
  [/^Cargo: selectors@0\.36\.1$/, 'scripts/licenses/selectors.txt'],
  [/^Cargo: unic-[\w-]+@0\.9\.0$/, 'scripts/licenses/unic.txt'],
  [/^Cargo: webview2-com(?:-macros|-sys)?@0\.38\.2$|^Cargo: webview2-com-macros@0\.8\.1$/, 'scripts/licenses/webview2.txt'],
];
function collect(label, dir, license) {
  const files = fs.readdirSync(dir).filter(n => /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(n) && fs.statSync(path.join(dir, n)).isFile());
  const licenseDir = path.join(dir, 'licenses');
  if (fs.existsSync(licenseDir)) {
    for (const n of fs.readdirSync(licenseDir)) if (fs.statSync(path.join(licenseDir, n)).isFile()) files.push(`licenses/${n}`);
  }
  const supplement = !files.length && supplements.find(([pattern]) => pattern.test(label));
  if (!files.length && !supplement) missing.push(label);
  sections.push(`\n${'='.repeat(72)}\n${label}\nDeclared license: ${license || 'UNSPECIFIED'}\n`);
  if (label === 'Cargo: selectors@0.36.1') sections.push('Unmodified MPL-2.0 source available at https://crates.io/crates/selectors/0.36.1 and https://github.com/servo/stylo/tree/635e1a19d02960588a00e189bd4bd5bdb150ec3d/selectors\n');
  if (supplement) sections.push(fs.readFileSync(supplement[1], 'utf8'));
  for (const file of files.sort()) sections.push(`\n--- ${file} ---\n${fs.readFileSync(path.join(dir, file), 'utf8')}\n`);
}
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
for (const [location, item] of Object.entries(lock.packages)) {
  if (!location || item.dev || !fs.existsSync(path.join(location, 'package.json'))) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8'));
  collect(`npm: ${pkg.name}@${pkg.version}`, location, pkg.license);
}
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', 'src-tauri/Cargo.toml'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const used = new Set(metadata.resolve.nodes.map(n => n.id));
for (const pkg of metadata.packages.filter(p => used.has(p.id) && p.source).sort((a,b) => a.name.localeCompare(b.name))) {
  collect(`Cargo: ${pkg.name}@${pkg.version}`, path.dirname(pkg.manifest_path), pkg.license);
}
if (missing.length) {
  console.error('No license text found for:\n' + missing.join('\n'));
  process.exit(1);
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), sections.join(''), 'utf8');
console.log(`Generated notices (${sections.length} sections).`);
