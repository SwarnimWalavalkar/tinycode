import { HttpError } from "./http.js";
import type { VmRuntime } from "./vm-tools.js";

// JSON is base64 encoded before crossing the shell boundary. All filesystem paths
// are resolved inside /workspace, including symlinks, by the sandbox-side program.
export function workspaceCommand(
  action: string,
  path: string,
  input: Record<string, unknown> = {},
) {
  if (!["tree", "file", "save", "git", "diff"].includes(action))
    throw new HttpError(400, "Invalid workspace action");
  if (path.length > 4096 || path.includes("\0"))
    throw new HttpError(400, "Invalid path");
  const payload = btoa(
    unescape(encodeURIComponent(JSON.stringify({ action, path, ...input }))),
  );
  const program = String.raw`
import os,json,base64,hashlib,subprocess,sys
from pathlib import Path
v=json.loads(base64.b64decode(sys.argv[1]))
root=Path('/workspace').resolve()
git_root=root
def emit(value): print(json.dumps(value))
def git(*args):
 p=subprocess.run(['git','--literal-pathspecs','--no-optional-locks','-c','core.fsmonitor=false',*args],cwd=git_root,capture_output=True,timeout=15)
 if len(p.stdout)>2000000: raise ValueError('Output too large')
 return p
def read(p):
 if p.stat().st_size>1000000: raise ValueError('File too large to preview')
 data=p.read_bytes()
 if b'\x00' in data: raise ValueError('Binary file cannot be previewed')
 return data.decode('utf-8'),hashlib.sha256(data).hexdigest()
try:
 rel=v['path']
 if os.path.isabs(rel): raise ValueError('Use a workspace-relative path')
 p=(root/rel).resolve()
 if not p.is_relative_to(root): raise ValueError('Path is outside workspace')
 action=v['action']
 if action in ('file','save','diff') and (p==root or p.is_dir()): raise ValueError('Choose a file')
 if action=='tree':
  entries=[]
  for child in sorted(p.iterdir(),key=lambda c:(not c.is_dir(),c.name)):
   if child.name=='.git': continue
   if len(entries)>=5000: raise ValueError('Directory contains too many entries')
   entries.append({'name':child.name,'path':str(child.relative_to(root)),'type':'symlink' if child.is_symlink() else 'directory' if child.is_dir() else 'file'})
  emit(entries)
 elif action in ('file','save'):
  content,revision=read(p)
  if action=='save':
   if revision!=v.get('revision'): raise ValueError('File changed; reopen before saving')
   content=v['content']
   if len(content.encode())>1000000: raise ValueError('File too large')
   # Atomic rename avoids partial files if a reader opens during save.
   import tempfile
   fd,tmp=tempfile.mkstemp(dir=p.parent,prefix='.tinycode-')
   try:
    with os.fdopen(fd,'w',encoding='utf-8') as out: out.write(content)
    os.chmod(tmp,p.stat().st_mode)
    os.replace(tmp,p)
   finally:
    if os.path.exists(tmp): os.unlink(tmp)
   content,revision=read(p)
  emit({'path':rel,'content':content,'revision':revision})
 elif action=='git':
  valid=git('rev-parse','--is-inside-work-tree').returncode==0
  if not valid:
   repos=[d for d in root.iterdir() if d.is_dir() and d.resolve().is_relative_to(root) and (d/'.git').exists()]
   if len(repos)==1:
    git_root=repos[0]; valid=git('rev-parse','--is-inside-work-tree').returncode==0
  if not valid: emit({'isGit':False,'branch':None,'files':[]})
  else:
   result=git('status','--porcelain=v1','-z','--untracked-files=all')
   if result.returncode: raise ValueError('Cannot read Git status')
   items=result.stdout.decode().split('\x00'); files=[]; i=0
   while i<len(items):
    item=items[i]; i+=1
    if not item: continue
    status=item[:2]; name=str((git_root/item[3:]).relative_to(root))
    files.append({'path':name,'status':status})
    if 'R' in status or 'C' in status: i+=1
   emit({'isGit':True,'branch':git('branch','--show-current').stdout.decode().strip() or None,'files':files})
 elif action=='diff':
  git_root=p.parent
  while git_root!=root and not (git_root/'.git').exists(): git_root=git_root.parent
  rel_git=str(p.relative_to(git_root))
  head=git('rev-parse','--verify','HEAD').returncode==0
  tracked=git('ls-files','--error-unmatch','--',rel_git).returncode==0
  if (not tracked or not head) and p.is_file():
   content,_=read(p); emit({'content':'','newFile':{'name':rel,'contents':content}})
  else:
   head=git('rev-parse','--verify','HEAD').returncode==0
   result=git('diff','--no-ext-diff','--no-textconv',*(['HEAD'] if head else ['--cached']),'--',rel_git)
   if result.returncode: raise ValueError('Cannot read diff')
   emit({'content':result.stdout.decode('utf-8','replace')})
except Exception as e:
 emit({'error':str(e)})
`;
  const script = btoa(unescape(encodeURIComponent(program)));
  return `python3 -c "import base64; exec(base64.b64decode('${script}'))" '${payload}'`;
}
export async function readWorkspace(
  vm: VmRuntime,
  action: string,
  path: string,
  input: Record<string, unknown> = {},
) {
  const result = await vm.exec(
    workspaceCommand(action, path, input),
    "/workspace",
    30000,
  );
  if (!result.success)
    throw new HttpError(
      409,
      "Sandbox is unavailable; try again when the current command finishes",
    );
  let value: any;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new HttpError(502, "Invalid workspace response");
  }
  if (value?.error) throw new HttpError(400, String(value.error));
  return value;
}
