import sys
import re
import os

if len(sys.argv) < 2:
    print("Usage: python3 patch_smali.py <smali_path>")
    sys.exit(1)

smali_path = sys.argv[1]
if not os.path.exists(smali_path):
    print("ERROR: not found: " + smali_path)
    sys.exit(1)

with open(smali_path, 'r') as f:
    content = f.read()

print("File: " + smali_path)
print("Size: " + str(len(content)))

# Find onWebContentsReady method
idx = content.find('onWebContentsReady')
if idx < 0:
    print("ERROR: onWebContentsReady not found")
    sys.exit(1)

method_text = content[idx:idx+3000]
print("=== Method ===")
print(method_text)

# Get current register count from .registers inside this method
reg_m = re.search(r'\.registers (\d+)', method_text)
if not reg_m:
    print("ERROR: .registers not found in method")
    sys.exit(1)

old_regs = int(reg_m.group(1))
print("\nCurrent .registers: " + str(old_regs))

# Count parameters: method is void onWebContentsReady()
# It's an interface method on inner class, so p0 = this (CobaltActivity$2)
# No other params. So param_count = 1
param_count = 1

# In Dalvik: locals = registers - params
# p0 = v(old_regs - 1)
# We need 4 extra local registers
extra = 4
new_regs = old_regs + extra

# When we increase .registers by N, all existing pN stay at top
# but vX (locals) shift up by N. We must renumber all existing vX in the method.
# pX references stay as pX - no change needed for pX.
# vX references: new_vX = old_vX + extra

# Extract just the method body
method_start = content.find('.method', content.find('onWebContentsReady'))
method_end = content.find('.end method', method_start) + len('.end method')
method_body = content[method_start:method_end]

print("\nRenumbering v registers by +" + str(extra))

def renumber_v(match):
    num = int(match.group(1))
    return 'v' + str(num + extra)

# Renumber all vN references (not pN)
new_body = re.sub(r'\bv(\d+)\b', renumber_v, method_body)

# Update .registers
new_body = re.sub(r'\.registers \d+', '.registers ' + str(new_regs), new_body, count=1)

# Our new registers are v0..v(extra-1)
# r0=v0: CobaltActivity reference
# r1=v1: AssetManager / Scanner
# r2=v2: string temp
# r3=v3: bool temp

# Find this$0 field
this0_field = 'Ldev/cobalt/coat/CobaltActivity$2;->this$0:Ldev/cobalt/coat/CobaltActivity;'

inject = """
    # === VOT Injection ===
    iget-object v0, p0, {this0}
    invoke-virtual {{v0}}, Ldev/cobalt/coat/CobaltActivity;->getAssets()Landroid/content/res/AssetManager;
    move-result-object v1

    const-string v2, "vot.js"
    invoke-virtual {{v1, v2}}, Landroid/content/res/AssetManager;->open(Ljava/lang/String;)Ljava/io/InputStream;
    move-result-object v1

    new-instance v2, Ljava/util/Scanner;
    const-string v3, "UTF-8"
    invoke-direct {{v2, v1, v3}}, Ljava/util/Scanner;-><init>(Ljava/io/InputStream;Ljava/lang/String;)V

    const-string v3, "\\\\A"
    invoke-virtual {{v2, v3}}, Ljava/util/Scanner;->useDelimiter(Ljava/lang/String;)Ljava/util/Scanner;
    move-result-object v2

    invoke-virtual {{v2}}, Ljava/util/Scanner;->hasNext()Z
    move-result v3

    const-string v2, ""
    if-eqz v3, :vot_skip

    invoke-virtual {{v2}}, Ljava/util/Scanner;->next()Ljava/lang/String;
    move-result-object v2

    :vot_skip
    invoke-virtual {{v0, v2}}, Ldev/cobalt/coat/CobaltActivity;->evaluateJavaScript(Ljava/lang/String;)V
    # === End VOT ===
""".format(this0=this0_field)

# Find injection point - after loadSplashScreenWebContents
targets = re.findall(
    r'invoke-virtual \{[^}]+\}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents\(\)V',
    new_body
)
print("\nSplash targets found: " + str(targets))

if targets:
    target = targets[0]
    new_body = new_body.replace(target, target + inject, 1)
    print("SUCCESS: injected")
else:
    # Try loadUrl
    targets2 = re.findall(
        r'invoke-virtual \{[^}]+\}, Ldev/cobalt/shell/Shell;->loadUrl\(Ljava/lang/String;\)V',
        new_body
    )
    print("loadUrl targets: " + str(targets2))
    if targets2:
        target = targets2[-1]  # last loadUrl call
        new_body = new_body.replace(target, target + inject, 1)
        print("SUCCESS: injected after loadUrl")
    else:
        print("ERROR: no injection point found")
        sys.exit(1)

# Replace method in full content
new_content = content[:method_start] + new_body + content[method_end:]

with open(smali_path, 'w') as f:
    f.write(new_content)

print("\nDone. New .registers: " + str(new_regs))
