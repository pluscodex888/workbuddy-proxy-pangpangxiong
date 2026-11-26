import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function privateRuntime(root) {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(process.platform==='win32') {
    const user=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
    const sid=user.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
    if(!sid)throw new Error('runtime_acl_user_unresolved');
    // Reapplying inheritable ACLs propagates through an existing dependency
    // cache and can hold startup for minutes. Verify the exact protected ACL
    // first; keep the repair for new or incorrectly secured directories.
    const literal=String(root).replaceAll("'","''");
    const check=`$ProgressPreference='SilentlyContinue';$a=Get-Acl -LiteralPath '${literal}';$s=@('${sid}','S-1-5-18');$r=@($a.Access);$ok=$a.AreAccessRulesProtected -and $r.Count -eq 2;foreach($x in $r){$id=$x.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;$ok=$ok -and ($s -contains $id) -and $x.AccessControlType -eq 'Allow' -and $x.FileSystemRights -eq 'FullControl' -and (($x.InheritanceFlags -band 3) -eq 3)};if($ok){'private'}`;
    const encoded=Buffer.from(check,'utf16le').toString('base64');
    const secured=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{encoding:'utf8',windowsHide:true,timeout:10000});
    if(secured.trim()==='private')return;
    execFileSync('icacls.exe',[root,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{stdio:'pipe',windowsHide:true});
  } else fs.chmodSync(root,0o700);
}
