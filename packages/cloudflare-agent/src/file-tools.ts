import type { VmRuntime } from "./vm-tools.js";

// Keep file operations in the guest, behind the same cancellation/recovery path as shell.
// Encode both code and arguments so paths and file contents never become shell syntax.
export function fileCommand(input: Record<string, unknown>): string {
  const payload = JSON.stringify(input);
  if (new TextEncoder().encode(payload).length > 40_000)
    throw new Error("File tool input too large; split the edit into smaller calls");
  const program = String.raw`
import os,json,base64,hashlib,tempfile,difflib,sys
from pathlib import Path
v=json.loads(base64.b64decode(sys.argv[1]))
root=Path('/workspace').resolve()
def digest(data): return hashlib.sha256(data).hexdigest()
def emit(value): print(json.dumps(value,ensure_ascii=False))
try:
 path=v['path']
 if not isinstance(path,str) or not path or len(path)>4096 or '\x00' in path: raise ValueError('Invalid file path')
 p=(root/path).resolve()
 if not p.is_relative_to(root): raise ValueError('Path is outside /workspace')
 if p==root or p.is_dir(): raise ValueError('Choose a file')
 exists=p.exists()
 if exists and (not p.is_file() or p.stat().st_size>1000000): raise ValueError('Expected a regular file of at most 1 MB; use shell for larger files')
 data=p.read_bytes() if exists else b''
 if b'\x00' in data: raise ValueError('Binary files are not supported; use shell')
 original=data.decode('utf-8')
 revision=digest(data) if exists else None
 if v['action']=='read':
  if not exists: raise ValueError('File does not exist')
  offset=v.get('offset',1); limit=v.get('limit',200)
  if type(offset)!=int or offset<1 or type(limit)!=int or not 1<=limit<=2000: raise ValueError('Invalid offset or limit')
  lines=original.splitlines(keepends=True)
  if offset>max(1,len(lines)): raise ValueError('Offset is beyond end of file')
  selected=[]; size=0
  for line in lines[offset-1:offset-1+limit]:
   length=len(line.encode('utf-8'))
   if size+length>16384: break
   selected.append(line); size+=length
  if not selected and offset<=len(lines): raise ValueError('This line exceeds the 16 KiB read limit; use shell to extract a bounded section')
  end=offset-1+len(selected)
  emit({'path':str(p.relative_to(root)),'content':''.join(selected),'offset':offset,'endLine':end,'totalLines':len(lines),'revision':revision,'truncated':end<len(lines),'nextOffset':end+1 if end<len(lines) else None})
 elif v['action']=='edit':
  if 'revision' in v and v['revision']!=revision: raise ValueError('File changed; read it again before editing')
  mode=v.get('mode','replace'); replacements=0
  if mode=='write':
   if 'edits' in v: raise ValueError('Use content for write mode, not edits')
   updated=v['content']
   if not isinstance(updated,str): raise ValueError('content must be text')
  elif mode=='replace':
   if not exists: raise ValueError('File does not exist; use write mode to create it')
   if 'content' in v: raise ValueError('Use edits for replace mode, not content')
   edits=v.get('edits')
   if not isinstance(edits,list) or not 1<=len(edits)<=100: raise ValueError('Provide 1 to 100 exact edits')
   ranges=[]
   for i,edit in enumerate(edits):
    old=edit['oldText']; new=edit['newText']
    if not isinstance(old,str) or not old or not isinstance(new,str) or old==new: raise ValueError('Each edit needs nonempty oldText and different newText')
    start=original.find(old)
    if start<0 or original.find(old,start+1)>=0: raise ValueError('Edit '+str(i+1)+' must match exactly once; read the file and include unique context')
    ranges.append((start,start+len(old),new))
   ranges.sort()
   for a,b in zip(ranges,ranges[1:]):
    if b[0]<a[1]: raise ValueError('Edits overlap; combine them into a single edit')
   updated=original
   for start,end,new in reversed(ranges): updated=updated[:start]+new+updated[end:]
   replacements=len(ranges)
  else: raise ValueError('Invalid edit mode')
  encoded=updated.encode('utf-8')
  if len(encoded)>1000000 or '\x00' in updated: raise ValueError('Expected UTF-8 text of at most 1 MB without NUL bytes')
  p.parent.mkdir(parents=True,exist_ok=True)
  fd,tmp=tempfile.mkstemp(dir=p.parent,prefix='.tinycode-')
  try:
   with os.fdopen(fd,'wb') as out: out.write(encoded)
   if exists: os.chmod(tmp,p.stat().st_mode)
   os.replace(tmp,p)
  finally:
   if os.path.exists(tmp): os.unlink(tmp)
  diff=''.join(difflib.unified_diff(original.splitlines(keepends=True),updated.splitlines(keepends=True),fromfile=path,tofile=path))
  emit({'path':str(p.relative_to(root)),'mode':mode,'bytes':len(encoded),'revision':digest(encoded),'replacements':replacements,'diff':diff[:8192],'diffTruncated':len(diff)>8192})
 else: raise ValueError('Invalid file action')
except Exception as e:
 emit({'error':str(e)})
`;
  const encode = (value: string) => btoa(unescape(encodeURIComponent(value)));
  return `python3 -c "import base64; exec(base64.b64decode('${encode(program)}'))" '${encode(payload)}'`;
}

export async function runFileTool(vm: VmRuntime, input: Record<string, unknown>, signal?: AbortSignal) {
  const output = await vm.exec(fileCommand(input), "/workspace", 30_000, signal);
  if (!output.success) throw new Error(output.stderr || "File operation failed");
  const value: unknown = JSON.parse(output.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid file tool response");
  if ("error" in value) throw new Error(String(value.error));
  return value;
}
