import { afterEach, describe, expect, it, vi } from "vitest";
import { createToastStack } from "../../src/public/toast-stack.js";

class TestElement {
  ownerDocument: TestDocument;
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  classes = new Set<string>();
  classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  style = { setProperty: vi.fn() };
  listeners = new Map<string, Array<(event: TestEvent) => void>>();
  hidden = false;
  inert = false;
  tabIndex = -1;
  textContent = "";
  constructor(document: TestDocument) { this.ownerDocument = document; }
  get lastElementChild() { return this.children.at(-1); }
  append(...children: TestElement[]) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: (event: TestEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  dispatch(name: string, key = "") {
    const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    this.listeners.get(name)?.forEach((handler) => handler(event));
    return event;
  }
  click() { this.dispatch("click"); }
  focus() { this.ownerDocument.activeElement = this; }
}
type TestEvent = { key: string; preventDefault(): void; stopPropagation(): void };
class TestDocument {
  activeElement: TestElement | null = null;
  createElement() { return new TestElement(this); }
}

function fixture() {
  vi.useFakeTimers();
  const document = new TestDocument();
  const region = document.createElement();
  const onEmpty = vi.fn();
  const stack = createToastStack(region as unknown as HTMLElement, { onEmpty });
  const root = stack.element as unknown as TestElement;
  const [toggle, list] = root.children;
  if (!toggle || !list) throw new Error("Missing toast stack controls");
  function add(message: string) {
    const toast = document.createElement();
    toast.textContent = message;
    stack.add(toast as unknown as HTMLElement);
    return toast;
  }
  return { document, region, stack, root, toggle, list, onEmpty, add };
}

afterEach(() => vi.useRealTimers());

describe("通知收拢堆叠", () => {
  it("不同内容和重复通知都收拢，点击展开而非关闭，并支持再次收起", () => {
    const { add, root, toggle, list } = fixture();
    const first = add("保存成功");
    add("章节已发生变化，请刷新后重试");
    add("章节已发生变化，请刷新后重试");
    expect(root.dataset).toMatchObject({ stacked: "true", expanded: "false" });
    expect(toggle.attributes["aria-label"]).toBe("展开 3 条通知");
    expect(first.inert).toBe(true);
    toggle.click();
    expect(list.children).toHaveLength(3);
    expect(root.dataset.expanded).toBe("true");
    expect(first.inert).toBe(false);
    expect(first.tabIndex).toBe(0);
    toggle.click();
    expect(root.dataset.expanded).toBe("false");
  });

  it("各条按自己的时限消失，展开及展开后新增的通知暂停计时", () => {
    const { add, toggle, list, onEmpty } = fixture();
    add("first");
    vi.advanceTimersByTime(1000);
    add("second");
    toggle.click();
    add("third");
    vi.advanceTimersByTime(20_000);
    expect(list.children).toHaveLength(3);
    toggle.click();
    vi.advanceTimersByTime(2600);
    expect(list.children.map((item) => item.textContent)).toEqual(["second", "third"]);
    vi.advanceTimersByTime(1000);
    expect(list.children).toHaveLength(0);
    expect(onEmpty).toHaveBeenCalledOnce();
  });

  it("展开后逐条关闭，剩一条时保持可操作，Escape 只收起通知", () => {
    const { add, toggle, root, document, list } = fixture();
    const first = add("first");
    const second = add("second");
    toggle.click();
    const event = root.dispatch("keydown", "Escape");
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(root.dataset.expanded).toBe("false");
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    first.focus();
    first.dispatch("keydown", "Enter");
    expect(list.children).toEqual([second]);
    expect(toggle.hidden).toBe(true);
    expect(document.activeElement).toBe(second);
    second.dispatch("keydown", " ");
    expect(root.parentElement).toBeNull();
  });

  it("特殊通知不归堆叠管理，清空后无残留计时且支持重新显示", () => {
    const { add, stack, region, root, document, onEmpty } = fixture();
    const special = document.createElement();
    region.append(special);
    add("first");
    add("second");
    expect(stack.dismiss(special as unknown as HTMLElement)).toBe(false);
    stack.clear();
    expect(region.children).toEqual([special]);
    expect(vi.getTimerCount()).toBe(0);
    expect(onEmpty).toHaveBeenCalledOnce();
    add("new");
    expect(region.children).toEqual([special, root]);
    expect(root.dataset.expanded).toBe("false");
  });
});
