import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./schema.js";
import { Ledger } from "./ledger.js";
import { SqliteMailbox } from "./message.js";
import { Tools } from "./tools.js";
import { fileTools } from "./files.js";
import { webTools, webFromEnv } from "./web.js";
import { inspectTool, agentTool } from "./builtin.js";
import type { ModelClient } from "./model.js";

/**
 * One project on disk. The ledger, the milestones and every letter between
 * agents share one file, so closing the process loses nothing.
 */
export class Store {
  private readonly db: DatabaseSync;
  readonly ledger: Ledger;
  readonly mailbox: SqliteMailbox;
  /** Every tool that exists, with the message tool and both builtins on it. */
  readonly tools: Tools;

  /**
   * `root` is the local machine the ledger and the file tools both sit on.
   * Passing `baseUrl` instead puts the file tools on a remote machine and
   * leaves the ledger where it is, because the ledger is this process's own
   * bookkeeping and has no business on someone else's disk.
   */
  constructor(
    path: string,
    root: string,
    model: ModelClient,
    machine: {
      baseUrl?: string | undefined;
      token?: string | undefined;
      /**
       * A Web-Kit server, overriding WEBKIT_URL and WEBKIT_API_TOKEN. Left out
       * of most runs on purpose: the environment decides, and the deployed
       * instance is the fallback.
       */
      webUrl?: string | undefined;
      webToken?: string | undefined;
    } = {},
  ) {
    // An explicit option wins, then the environment, then the deployed server.
    const web = {
      ...webFromEnv(),
      ...(machine.webUrl ? { baseUrl: machine.webUrl } : {}),
      ...(machine.webToken ? { token: machine.webToken } : {}),
    };

    this.db = openDatabase(path);
    this.ledger = new Ledger(this.db);
    this.mailbox = new SqliteMailbox(this.db);
    this.tools = new Tools(this.mailbox)
      .withMessaging()
      .add(...fileTools({ root, baseUrl: machine.baseUrl, token: machine.token }))
      .add(...webTools(web))
      .add(inspectTool({ model, tools: this.toolsRef() }))
      .add(agentTool({ model, tools: this.toolsRef() }));
  }

  private toolsRef(): Tools {
    return this.tools;
  }

  /** Scoped tool list that still shares this store's mailbox and id counter. */
  forTools(names: string[]): Tools {
    return this.tools.use(names);
  }

  close(): void {
    this.ledger.close();
    this.db.close();
  }
}
