import { render } from "preact";
import { App } from "./App";
import { connect } from "./conn";
import "./kit/tokens.css";
import "./kit/fonts-ha.css";
import "./kit/base.css";
import "./kit/zigbee.css";
import "./style.css";

connect();
render(<App />, document.getElementById("app")!);
