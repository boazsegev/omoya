/** App.Web serves the browser application. Protocol, sessions and host are owning internal modules. */
import { serve } from "./server.js";

/** Static Web facade: serve(state) starts a host and returns its awaited stop/done lifecycle. */
export class Web {}
Object.assign(Web, { serve });
export default Web;
