import sys
import re
import os

if len(sys.argv) < 2:
    print("Usage: python3 patch_smali.py <path>")
    sys.exit(1)

smali_path = sys.argv[1]

if not os.path.exists(smali_path):
    print("ERROR: File not found: " + smali_path)
    sys.exit(1)

with open(smali_path, 'r') as f:
    content = f.read()

print("File size: " + str(len(content)) + " chars")

# Show onWebContentsReady
idx = content.find('onWebContentsReady')
if idx >= 0:
    print("=== onWebContentsReady ===")
    print(content[idx:idx+3000])

# Find current register count
reg_match = re.search(r'\.registers (\d+)', content)
current_regs = int(reg_match.group(1)) if reg_match else 8
print("\nCurrent .registers: " + str(current_regs))

# We need 4 extra registers, but max is 16
# Use the last available slots
# If current is e.g. 10, we can use v10,v11,v12,v13 (adding 4 more = 14 total)
new_regs = min(current_regs + 4, 16)
r0 = current_regs       # activity register
r1 = current_regs + 1   # assetManager / scanner
r2 = current_regs + 2   # string / temp
r3 = current_regs + 3   # bool / temp

print("New .registers: " + str(new_regs))
print("Using regs: v{}, v{}, v{}, v{}".format(r0, r1, r2, r3))

# Find this$0 field descriptor
this0_match = re.search(
    r'iget-object \w+, p0, (Ldev/cobalt/coat/CobaltActivity\$2;->this\$0:Ldev/cobalt/coat/CobaltActivity;)',
    content
)
this0_field = this0_match.group(1) if this0_match else 'Ldev/cobalt/coat/CobaltActivity$2;->this$0:Ldev/cobalt/coat/CobaltActivity;'
print("this$0 field: " + this0_field)

inject = """

    # === VOT Injection ===
    iget-object v{r0}, p0, {this0}
    invoke-virtual {{v{r0}}}, Ldev/cobalt/coat/CobaltActivity;->getAssets()Landroid/content/res/AssetManager;
    move-result-object v{r1}

    const-string v{r2}, "vot.js"
    invoke-virtual {{v{r1}, v{r2}}}, Landroid/content/res/AssetManager;->open(Ljava/lang/String;)Ljava/io/InputStream;
    move-result-object v{r1}

    new-instance v{r2}, Ljava/util/Scanner;
    const-string v{r3}, "UTF-8"
    invoke-direct {{v{r2}, v{r1}, v{r3}}}, Ljava/util/Scanner;-><init>(Ljava/io/InputStream;Ljava/lang/String;)V

    const-string v{r3}, "\\\\A"
    invoke-virtual {{v{r2}, v{r3}}}, Ljava/util/Scanner;->useDelimiter(Ljava/lang/String;)Ljava/util/Scanner;
    move-result-object v{r2}

    invoke-virtual {{v{r2}}}, Ljava/util/Scanner;->hasNext()Z
    move-result v{r3}

    const-string v{r2}, ""
    if-eqz v{r3}, :vot_skip

    invoke-virtual {{v{r2}}}, Ljava/util/Scanner;->next()Ljava/lang/String;
    move-result-object v{r2}

    :vot_skip
    invoke-virtual {{v{r0}, v{r2}}}, Ldev/cobalt/coat/CobaltActivity;->evaluateJavaScript(Ljava/lang/String;)V
    # === End VOT ===
""".format(r0=r0, r1=r1, r2=r2, r3=r3, this0=this0_field)

# Try injection targets
targets = [
    'invoke-virtual {v4}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V',
    'invoke-virtual {v3}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V',
    'invoke-virtual {v5}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V',
    'invoke-virtual {v6}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V',
]

# Also try regex
m = re.search(r'(invoke-virtual \{v\d+\}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents\(\)V)', content)
if m:
    targets.insert(0, m.group(1))

found = False
for target in targets:
    if target in content:
        new_content = content.replace(target, target + inject, 1)
        # Update register count
        new_content = re.sub(r'\.registers \d+', '.registers ' + str(new_regs), new_content, count=1)
        with open(smali_path, 'w') as f:
            f.write(new_content)
        print("\nSUCCESS: injected after: " + target)
        found = True
        break

if not found:
    print("\nERROR: no injection point found")
    print("Shell calls in file:")
    for line in content.split('\n'):
        if 'Shell;->' in line:
            print(line)
    sys.exit(1)
