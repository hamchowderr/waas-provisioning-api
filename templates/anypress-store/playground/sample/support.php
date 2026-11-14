<?php
/**
 * Fluent Support: the site's admin as the support agent (as Fluent Support does the first time an admin opens it),
 * and months of customer tickets: older ones answered and closed, recent ones waiting on the customer or new.
 */
use FluentSupport\App\Models\Conversation;
use FluentSupport\App\Models\Ticket;

$admin = wp_get_current_user();
if (!\FluentSupport\App\Services\Helper::getAgentByUserId($admin->ID)) {
    FluentSupportApi('agents')->createAgentWithOrWithoutWpUser([
        'email' => $admin->user_email,
        'first_name' => $admin->first_name ?: 'Site',
        'last_name' => $admin->last_name ?: 'Owner',
        'user_id' => $admin->ID,
    ]);
}

foreach ($sample['tickets'] as $n => [$who, $title, $question, $answers, $state, $daysAgo]) {
    $when = anypress_sample_when($daysAgo, 9 + $n % 8);
    $p = $sample['people'][$who];
    [, $made] = anypress_sample_api('POST', '/fluent-support/v2/tickets', [
        'ticket' => ['title' => $title, 'content' => "<p>$question</p>", 'priority' => $n === 0 ? 'high' : 'normal'],
        'newCustomer' => ['first_name' => $p[0], 'last_name' => $p[1], 'email' => anypress_sample_email($p)],
    ]);
    $ticketId = (int) ($made['ticket']['id'] ?? 0);
    if (!$ticketId) {
        continue;
    }
    foreach ($answers as $answer) {
        anypress_sample_api('POST', "/fluent-support/v2/tickets/$ticketId/responses", ['content' => "<p>$answer</p>", 'conversation_type' => 'response', 'close_ticket' => 'no', 'force_send' => 'yes']);
    }
    if ($state === 'closed') {
        anypress_sample_api('POST', "/fluent-support/v2/tickets/$ticketId/close", ['close_ticket_silently' => 'yes']);
    }
    // Dated when the customer wrote, with the answer a few hours later, and the emails they sent then too.
    $answered = gmdate('Y-m-d H:i:s', min(time() - 600, strtotime($when) + 3 * HOUR_IN_SECONDS));
    foreach (Conversation::where('ticket_id', $ticketId)->get() as $c => $conversation) {
        $conversation->created_at = $c ? $answered : $when;
        $conversation->updated_at = $conversation->created_at;
        $conversation->save();
    }
    $ticket = Ticket::find($ticketId);
    if ($ticket) {
        $ticket->created_at = $when;
        $ticket->updated_at = $answers ? $answered : $when;
        $ticket->last_customer_response = $when;
        $ticket->waiting_since = $answers ? $answered : $when;
        if ($answers) {
            $ticket->last_agent_response = $answered;
        }
        $ticket->save();
    }
    anypress_sample_mail_at($when);
}
