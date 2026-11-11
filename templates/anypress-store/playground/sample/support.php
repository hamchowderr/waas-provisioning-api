<?php
/**
 * Fluent Support: the site's admin as the support agent (as Fluent Support does the first time an admin opens it),
 * and a few customer tickets: new, answered and waiting on the customer, and closed with a thank-you.
 */
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

foreach ($sample['tickets'] as $n => [$who, $title, $question, $answers, $state]) {
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
    $ticket = Ticket::find($ticketId);
    if ($ticket) {
        $when = anypress_sample_when(1 + $n * 2.5, 10 + $n);
        $ticket->created_at = $when;
        $ticket->save();
    }
}
