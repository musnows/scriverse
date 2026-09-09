import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Agent 工具调用限制文档", () => {
  it("说明默认上限、环境变量和超限提示", async () => {
    const document = await readFile(join(process.cwd(), "showcase", "public", "docs", "global-tool-call-limit.html"), "utf8");

    expect(document).toContain("默认调用次数 20");
    expect(document).toContain("最小值为 10，默认值为 20，服务端默认最大值为 300");
    expect(document).toContain("SCRIVERSE_MAX_AGENT_TOOL_CALL_LIMIT");
    expect(document).toContain("10–1000");
    expect(document).toContain("保留已有回复与执行过程，并正常结束本次响应");
    expect(document).toContain("Agent 工具调用上限不能超过 X 次");
    expect(document).not.toContain("范围 5–48");
  });
});
