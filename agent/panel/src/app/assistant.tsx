'use client';

import { LogOutIcon } from 'lucide-react';
import { ChatPanel } from '@/components/chat-panel/chat-panel';
import type { ApprovalViews } from '@/components/chat/approval-view';
import { Button } from '@/components/ui/button';

/** The server sends a plain sentence with each change that waits (e.g. "Publish page 14"). */
const summary = ({ preview }: { preview?: unknown }) => (preview as { summary?: string } | undefined)?.summary;
const CHANGES = ['site_pages_change', 'page_section', 'site_styles_change', 'header_footer_change', 'site_menus_change'];
const approvalViews: ApprovalViews = Object.fromEntries(
  CHANGES.map((tool) => [tool, (approval) => (summary(approval) ? { title: `${summary(approval)}?` } : null)]),
);

/** The steps the owner sees in the conversation, in plain words. */
const toolTitles: Record<string, string> = {
  get_site: 'Reading your website',
  site_pages: 'Pages',
  site_patterns: 'Section designs',
  site_styles: 'Colours and fonts',
  header_footer: 'Header and footer',
  site_menus: 'Menus',
  add_image: 'Image',
  site_pages_change: 'Page change',
  page_section: 'Section change',
  site_styles_change: 'Colour and font change',
  header_footer_change: 'Header or footer change',
  site_menus_change: 'Menu change',
};

export function Assistant() {
  return (
    <ChatPanel
      className="h-full min-h-0 flex-1"
      title="Website assistant"
      plan={false}
      placeholder="What would you like to change?"
      greeting={{ title: 'What should we change?', description: 'Ask in plain words. Anything visitors would see waits for your yes.' }}
      suggestions={[
        { label: 'Add an FAQ page', prompt: 'Add an FAQ page with five common questions about my business.' },
        { label: 'Change my colours', prompt: 'Show me my site’s colours and suggest a fresher look.' },
        { label: 'Improve my home page', prompt: 'Read my home page and suggest three improvements.' },
      ]}
      approvalViews={approvalViews}
      toolTitles={toolTitles}
      actions={
        <form method="post" action="/signout">
          <Button type="submit" variant="ghost" size="icon" aria-label="Sign out" title="Sign out">
            <LogOutIcon />
          </Button>
        </form>
      }
    />
  );
}
