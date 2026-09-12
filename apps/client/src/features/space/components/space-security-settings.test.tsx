import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const updateSpace=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock("@/features/space/services/space-service.ts",()=>({updateSpace})); vi.mock("react-i18next",()=>({useTranslation:()=>({t:(v:string)=>v})}));
import SpaceSecuritySettings from "./space-security-settings";
if (!window.matchMedia) { Object.defineProperty(window, "matchMedia", { value: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }) }); }

describe("SpaceSecuritySettings",()=>{it("sends explicit public-sharing and viewer-comment controls",()=>{render(<MantineProvider><SpaceSecuritySettings space={{id:"space",settings:{sharing:{disabled:false},comments:{allowViewerComments:false}}} as any}/></MantineProvider>); fireEvent.click(screen.getByRole("switch", { name: "Allow public sharing" })); fireEvent.click(screen.getByRole("switch", { name: "Allow viewer comments" })); expect(updateSpace).toHaveBeenNthCalledWith(1,{id:"space",disablePublicSharing:true}); expect(updateSpace).toHaveBeenNthCalledWith(2,{id:"space",allowViewerComments:true});});});
