import "./styles.css";
import { createIcons, Languages } from "lucide";
import { initI18n } from "./i18n/index";
import "./load";
import { initApp } from "./app";

createIcons({ icons: { Languages } });

async function bootstrap(): Promise<void> {
  await initI18n();
  initApp();
}

void bootstrap();

export { bootstrap };
