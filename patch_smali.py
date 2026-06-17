import sys
import re
import os

if len(sys.argv) < 2:
    print("Usage: python3 patch_smali.py <path_to_CobaltActivity$2.smali>")
    sys.exit(1)

smali_path = sys.argv[1]

if not os.path.exists(smali_path):
    print("ERROR: File not found: " + smali_path)
    sys.exit(1)

with open(smali_path, 'r') as f:
    content = f.read()

print("File size: " + str(len(content)) + " chars")
print("")

# Show the onWebContentsReady method
idx = content.find('onWebContentsReady')
if idx >= 0:
    print("=== onWebContentsReady method ===")
    print(content[idx:idx+3000])
else:
    print("WARNING: onWebContentsReady not found, showing full file:")
    print(content)

# Find all invoke-virtual lines with Shell->load
load_lines = re.findall(r'invoke-virtual \{[^}]+\}, Ldev/cobalt/shell/Shell;->\w+\([^)]*\)\w*', content)
print("")
print("=== Shell method calls found ===")
for l in load_lines:
    print(l)

# Find CobaltActivity reference (v0, v1, v2, v3?)
activity_refs = re.findall(r'iget-object (v\d+), [^,]+, Ldev/cobalt/coat/CobaltActivity[^;]*;', content)
print("")
print("=== CobaltActivity register references ===")
for r in activity_refs:
    print(r)

# Try to find the outer class register (this$0)
this0 = re.findall(r'iget-object (v\d+), p0, Ldev/cobalt/coat/CobaltActivity\$2;->this\$0:Ldev/cobalt/coat/CobaltActivity;', content)
print("")
print("=== this$0 register ===")
print(this0)

# Try various injection targets
targets = [
    # loadSplashScreenWebContents with various registers
    ('splash_v4', 'invoke-virtual {v4}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V'),
    ('splash_v3', 'invoke-virtual {v3}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V'),
    ('splash_v5', 'invoke-virtual {v5}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V'),
    ('splash_v6', 'invoke-virtual {v6}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents()V'),
    # loadUrl with various registers
    ('loadurl_v4', 'invoke-virtual {v4, v3}, Ldev/cobalt/shell/Shell;->loadUrl(Ljava/lang/String;)V'),
    ('loadurl_v3', 'invoke-virtual {v3, v4}, Ldev/cobalt/shell/Shell;->loadUrl(Ljava/lang/String;)V'),
    ('loadurl_v3v2', 'invoke-virtual {v3, v2}, Ldev/cobalt/shell/Shell;->loadUrl(Ljava/lang/String;)V'),
    ('loadurl_v4v5', 'invoke-virtual {v4, v5}, Ldev/cobalt/shell/Shell;->loadUrl(Ljava/lang/String;)V'),
]

found_target = None
found_reg = None

for name, target in targets:
    if target in content:
        found_target = target
        print("")
        print("FOUND target: " + name + " -> " + target)
        # Extract the activity register from this$0 iget
        if this0:
            found_reg = this0[0]
        else:
            found_reg = 'v0'  # fallback
        break

if not found_target:
    print("")
    print("No standard target found. Trying regex search...")
    m = re.search(r'(invoke-virtual \{(v\d+)(?:, \w+)*\}, Ldev/cobalt/shell/Shell;->loadSplashScreenWebContents\(\)V)', content)
    if m:
        found_target = m.group(1)
        print("Found via regex: " + found_target)

if found_target:
    # Build the smali injection
    # We use v20-v23 as temp registers (high numbers to avoid conflicts)
    inject = """

    # === VOT JavaScript Injection ===
    iget-object v20, p0, Ldev/cobalt/coat/CobaltActivity$2;->this$0:Ldev/cobalt/coat/CobaltActivity;
    invoke-virtual {v20}, Ldev/cobalt/coat/CobaltActivity;->getAssets()Landroid/content/res/AssetManager;
    move-result-object v21

    const-string v22, "vot.js"
    invoke-virtual {v21, v22}, Landroid/content/res/AssetManager;->open(Ljava/lang/String;)Ljava/io/InputStream;
    move-result-object v21

    new-instance v22, Ljava/util/Scanner;
    const-string v23, "UTF-8"
    invoke-direct {v22, v21, v23}, Ljava/util/Scanner;-><init>(Ljava/io/InputStream;Ljava/lang/String;)V

    const-string v23, "\\\\A"
    invoke-virtual {v22, v23}, Ljava/util/Scanner;->useDelimiter(Ljava/lang/String;)Ljava/util/Scanner;
    move-result-object v22

    invoke-virtual {v22}, Ljava/util/Scanner;->hasNext()Z
    move-result v23

    const-string v22, ""
    if-eqz v23, :vot_skip

    invoke-virtual {v22}, Ljava/util/Scanner;->next()Ljava/lang/String;
    move-result-object v22

    :vot_skip
    invoke-virtual {v20, v22}, Ldev/cobalt/coat/CobaltActivity;->evaluateJavaScript(Ljava/lang/String;)V
    # === End VOT Injection ===
"""

    new_content = content.replace(found_target, found_target + inject, 1)

    if new_content != content:
        # Fix register count in .registers directive
        # Find current register count and increase it
        reg_match = re.search(r'\.registers (\d+)', new_content)
        if reg_match:
            current_regs = int(reg_match.group(1))
            new_regs = max(current_regs, 24)  # ensure at least 24 registers
            new_content = new_content.replace(
                '.registers ' + str(current_regs),
                '.registers ' + str(new_regs),
                1
            )
            print("Registers: " + str(current_regs) + " -> " + str(new_regs))

        with open(smali_path, 'w') as f:
            f.write(new_content)
        print("SUCCESS: smali patched")
    else:
        print("ERROR: replacement failed")
else:
    print("ERROR: Could not find injection point")
    print("Please share the output above to debug")
    sys.exit(1)
