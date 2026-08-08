import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Semaphore } from "@helix/jobs";

export interface BrowserManagerOptions {
  headless: boolean;
  defaultTimeoutSeconds: number;
}

/**
 * Single persistent Browser/Context/Page (SESS-001, ADR-001).
 * All operations run serialized through a Semaphore(1) (NFR-REL-003).
 * On browser process death the instance is discarded and lazily relaunched
 * on the next run (NFR-REL-002, ADR-004).
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private dead = false;
  private readonly limiter = new Semaphore(1);

  constructor(private readonly options: BrowserManagerOptions) {}

  isConnected(): boolean {
    return this.browser !== null && !this.dead && this.browser.isConnected();
  }

  private contextStatePath: string | null = null;

  private async launch(storageStatePath?: string): Promise<void> {
    const browser = await chromium.launch({ headless: this.options.headless });
    browser.on("disconnected", () => { this.dead = true; });
    this.browser = browser;
    this.dead = false;
    await this.openContext(storageStatePath);
  }

  private async openContext(storageStatePath?: string): Promise<void> {
    const context = await (this.browser as Browser).newContext(
      storageStatePath ? { storageState: storageStatePath } : {},
    );
    this.context = context;
    this.contextStatePath = storageStatePath ?? null;
    this.page = await context.newPage();
  }

  /**
   * Serialized operation on the single page, recreating the context when the
   * requested storageState differs from the current one (ADR-003).
   */
  async withContext<T>(storageStatePath: string | undefined, operation: (page: Page) => Promise<T>): Promise<T> {
    const target = storageStatePath && existsSync(storageStatePath) ? storageStatePath : null;
    return this.limiter.use(async () => {
      if (!this.isConnected() || !this.page) {
        await this.launch(target ?? undefined);
      } else if (this.contextStatePath !== target) {
        await this.context?.close().catch(() => {});
        await this.openContext(target ?? undefined);
      }
      return operation(this.page as Page);
    });
  }

  async run<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    return this.withContext(undefined, operation);
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (browser && !this.dead && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}