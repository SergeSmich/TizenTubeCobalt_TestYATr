import json
import subprocess
import urllib.request

remote = subprocess.check_output(
    ["git", "-C", r"F:\Projects\TizenTubeCobalt_TestYATr\_vhost", "remote", "get-url", "origin"],
    text=True,
).strip()
token = remote.split("SergeSmich:")[1].split("@")[0]

run_id = "28704028762"
req = urllib.request.Request(
    f"https://api.github.com/repos/SergeSmich/TizenTubeCobalt_TestYATr/actions/runs/{run_id}/jobs",
    headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
)
with urllib.request.urlopen(req) as resp:
    data = json.load(resp)

lines = []
for job in data.get("jobs", []):
    lines.append(f"JOB: {job['name']} - {job['status']}/{job['conclusion']}")
    for s in job.get("steps", []):
        lines.append(f"  {s['number']}. {s['name']}: {s['status']}/{s['conclusion']}")

with open(r"F:\Projects\TizenTubeCobalt_TestYATr\_run_status2.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("done")

