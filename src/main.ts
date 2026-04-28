import "./styles.css";
import { initI18n } from "./i18n/index";
import "./load";
import { initApp } from "./app";

async function bootstrap(): Promise<void> {
  await initI18n();
  initApp();
}

void bootstrap();

export { bootstrap };
