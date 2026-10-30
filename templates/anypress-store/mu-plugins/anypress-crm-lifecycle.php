<?php
/*
 * Plugin Name: AnyPress CRM lifecycle
 * Description: Tags every contact by what they bought or joined and where they are with it (Offering: Interested, Active, Past), from the site's own plugins (FluentCart, FluentBooking, FluentCommunity, FluentAffiliate), clears stale interest, starts the site's lifecycle emails once the owner publishes them, and emails the owner the week's numbers. Part of the store and storefront templates.
 */

/*
 * The method (the crm-lifecycle-tagging skill): lists are consent, tags are what the site knows, fields are single facts.
 *   Interested: wants it, hasn't bought. Removed when Active or Past arrives, and after STALE_DAYS.
 *   Active:     has it now. Only where the site can see the end (a subscription, an upcoming booking, an enrolment).
 *   Past:       has had it. Never removed, except by a full refund of the only purchase.
 * Buyers start "transactional"; an unsubscribed contact stays unsubscribed. Free FluentCRM can't start an automation
 * from a tag, so this plugin starts the lifecycle automations, which wait on a trigger that never fires by itself.
 * Each one starts only once it is published, once per contact.
 */
final class AnyPress_CRM_Lifecycle
{
    const STALE_DAYS = 120;
    const STAGES = ['Interested', 'Active', 'Past'];
    /** The placeholder condition that parks an automation on the registration trigger: only this plugin starts it. */
    const STARTED_BY_CODE = 'anypress_started_by_code';

    /** The contact form's field names (presets.php adds the fields to Fluent Forms' contact form). */
    const FORM_GROUP = 'customer_group';
    const FORM_INTEREST = 'interest';
    const FORM_NEWSLETTER = 'newsletter';
    const BOOKING_CHOICE = 'A booking';

    private static $applying = false;
    private static $community_signup = false;

    public static function boot(): void
    {
        add_action('fluent_crm/contact_added_to_tags', [self::class, 'on_tags_added'], 20, 2);
        add_action('fluentcrm_subscriber_status_to_subscribed', [self::class, 'start_nurture'], 20, 1);
        add_filter('fluentcrm_funnel_will_process_user_register', function ($will, $funnel) {
            return in_array(self::STARTED_BY_CODE, (array) (($funnel->conditions ?? [])['user_roles'] ?? []), true) ? false : $will;
        }, 20, 2);

        // WP Fusion makes new WordPress users FluentCRM contacts with its "Default Status", which the templates set to
        // transactional (an account isn't a newsletter sign-up). Its menu only offers subscribed, pending and
        // unsubscribed, so add transactional, or saving its settings screen would quietly switch everyone to subscribed.
        add_filter('wpf_configure_settings', function ($settings) {
            if (isset($settings['default_status']['choices']) && is_array($settings['default_status']['choices'])) {
                $settings['default_status']['choices'] = ['transactional' => 'Transactional (no marketing email until they sign up)']
                    + $settings['default_status']['choices'];
            }
            return $settings;
        }, 30, 1);

        if (defined('FLUENTCART_VERSION')) {
            add_action('fluent_cart/subscription_activated', [self::class, 'on_subscription_active'], 20, 1);
            add_action('fluent_cart/subscription_reactivated', [self::class, 'on_subscription_active'], 20, 1);
            foreach (['fluent_cart/subscription_canceled', 'fluent_cart/subscription_expired_validity', 'fluent_cart/subscription_eot'] as $hook) {
                add_action($hook, [self::class, 'on_subscription_end'], 20, 1);
            }
            add_action('fluent_cart/order_paid_done', [self::class, 'on_order_paid'], 20, 1);
            add_action('fluent_cart/order_fully_refunded', [self::class, 'on_full_refund'], 20, 1);
        }
        if (defined('FLUENT_BOOKING_VERSION')) {
            add_action('fluent_booking/after_booking_scheduled', [self::class, 'on_booking_scheduled'], 20, 1);
            add_action('fluent_booking/booking_schedule_completed', [self::class, 'on_booking_completed'], 20, 1);
            add_action('fluent_booking/booking_schedule_cancelled', [self::class, 'on_booking_cancelled'], 20, 1);
        }
        if (defined('FLUENTFORM')) {
            add_action('fluentform/submission_inserted', [self::class, 'on_contact_form'], 20, 3);
            add_filter('fluentform/rendering_field_data_select', [self::class, 'form_choices'], 20, 2);
        }
        if (defined('FLUENT_COMMUNITY_PLUGIN_VERSION')) {
            // Someone who signs up through the community but hasn't joined a space yet is interested in it. FluentCommunity
            // has no sign-up event of its own; its sign-up asks this filter for the new account's role just before it makes
            // the account.
            add_filter('fluent_community/created_user_role', function ($role) {
                self::$community_signup = true;
                return $role;
            }, 20, 1);
            add_action('user_register', [self::class, 'on_community_signup'], 20, 1);
            add_action('fluent_community/space/joined', [self::class, 'on_space_joined'], 20, 2);
            add_action('fluent_community/space/user_left', [self::class, 'on_space_left'], 20, 2);
            add_action('fluent_community/course/enrolled', [self::class, 'on_course_enrolled'], 20, 2);
            add_action('fluent_community/course/student_left', [self::class, 'on_course_left'], 20, 2);
        }
        if (defined('FLUENT_AFFILIATE_VERSION')) {
            add_action('fluent_affiliate/affiliate_created', [self::class, 'on_affiliate'], 20, 1);
            add_action('fluent_affiliate/affiliate_status_to_active', [self::class, 'on_affiliate'], 20, 1);
            add_action('fluent_affiliate/affiliate_status_to_inactive', [self::class, 'on_affiliate'], 20, 1);
        }

        add_action('anypress_crm_daily', [self::class, 'remove_stale_interest']);
        add_action('anypress_crm_weekly', [self::class, 'email_weekly_numbers']);
        if (!wp_next_scheduled('anypress_crm_daily')) {
            wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', 'anypress_crm_daily');
        }
        if (!wp_next_scheduled('anypress_crm_weekly')) {
            wp_schedule_event(strtotime('next monday 14:00 UTC'), 'weekly', 'anypress_crm_weekly');
        }
    }

    /**
     * The offering names this site uses, by where they come from. A storefront sells website plans, so its
     * subscriptions, abandoned checkouts and contact form are all "Website"; a store calls them Subscription, Shop
     * and Enquiry. Owners rename them by editing the anypress_crm_offerings option.
     */
    public static function offering(string $kind): string
    {
        $names = array_merge([
            'subscription' => 'Subscription',
            'order' => 'Shop',
            'enquiry' => 'Enquiry',
            'booking' => 'Bookings',
            'space' => 'Community',
            'course' => 'Course',
            'affiliate' => 'Affiliate',
        ], (array) get_option('anypress_crm_offerings', []));
        return (string) ($names[$kind] ?? '');
    }

    // ---- Tags ----------------------------------------------------------------------------------------------------

    private static function tag(string $offering, string $stage, bool $create = true): int
    {
        $title = "$offering: $stage";
        $tag = \FluentCrm\App\Models\Tag::where('title', $title)->first();
        if (!$tag && $create) {
            $tag = \FluentCrm\App\Models\Tag::create(['title' => $title, 'slug' => sanitize_title($title)]);
        }
        return $tag ? (int) $tag->id : 0;
    }

    public static function has($contact, string $offering, string $stage): bool
    {
        $id = self::tag($offering, $stage, false);
        return $id && $contact && $contact->hasAnyTagId([$id]);
    }

    public static function add($contact, string $offering, string $stage): void
    {
        if (!$contact || $offering === '') {
            return;
        }
        $contact->attachTags([self::tag($offering, $stage)]);
        self::mirror($contact, ["$offering: $stage"], true);
    }

    public static function remove($contact, string $offering, array $stages): void
    {
        if (!$contact || $offering === '') {
            return;
        }
        $ids = array_values(array_filter(array_map(fn($stage) => self::tag($offering, $stage, false), $stages)));
        $held = array_values(array_filter($ids, fn($id) => $contact->hasAnyTagId([$id])));
        if ($held) {
            $contact->detachTags($held);
            self::mirror($contact, array_map(fn($stage) => "$offering: $stage", $stages), false);
        }
    }

    /**
     * WP Fusion connected to another CRM (HighLevel, HubSpot...): the same tag names follow the contact there. WP
     * Fusion Lite syncs people with a WordPress account, which every FluentCart buyer has.
     */
    private static function mirror($contact, array $titles, bool $apply): void
    {
        if (!function_exists('wp_fusion') || !function_exists('wpf_get_option') || wpf_get_option('crm') === 'fluentcrm'
            || !wpf_get_option('connection_configured') || empty($contact->user_id)) {
            return;
        }
        $ids = array_values(array_filter(array_map('wpf_get_tag_id', $titles)));
        if ($ids) {
            $apply ? wp_fusion()->user->apply_tags($ids, (int) $contact->user_id) : wp_fusion()->user->remove_tags($ids, (int) $contact->user_id);
        }
    }

    /**
     * The rules, whoever added the tag (this plugin, an abandoned checkout, a form, the owner by hand): Interested never
     * sits with Active or Past of the same offering; Past removes Active. Then the matching lifecycle email starts.
     */
    public static function on_tags_added($contact, $tagIds): void
    {
        if (self::$applying) {
            return;
        }
        self::$applying = true;
        try {
            $titles = \FluentCrm\App\Models\Tag::whereIn('id', (array) $tagIds)->pluck('title')->toArray();
            foreach ($titles as $title) {
                if (!preg_match('/^(.+): (Interested|Active|Past)$/', (string) $title, $m)) {
                    continue;
                }
                [, $offering, $stage] = $m;
                if ($stage === 'Interested') {
                    if (self::has($contact, $offering, 'Active') || self::has($contact, $offering, 'Past')) {
                        self::remove($contact, $offering, ['Interested']);
                    }
                    continue;
                }
                self::remove($contact, $offering, $stage === 'Past' ? ['Interested', 'Active'] : ['Interested']);
                if ($stage === 'Active') {
                    self::start_automation("Welcome: $offering", $contact);
                } elseif ($offering === self::offering('order') && $offering !== self::offering('subscription')) {
                    self::start_automation("Thank you: $offering", $contact);
                } else {
                    self::start_automation("Win-back: $offering", $contact);
                }
            }
        } finally {
            self::$applying = false;
        }
    }

    public static function start_automation(string $title, $contact): void
    {
        if (!$contact || !class_exists('\FluentCrm\App\Services\Funnel\FunnelProcessor')
            || in_array($contact->status, ['unsubscribed', 'bounced', 'complained', 'spammed'], true)) {
            return; // nobody who said stop, or whose address doesn't work, gets lifecycle email
        }
        $funnel = \FluentCrm\App\Models\Funnel::where('title', $title)->where('status', 'published')->first();
        if (!$funnel || \FluentCrm\App\Models\FunnelSubscriber::where('funnel_id', $funnel->id)->where('subscriber_id', $contact->id)->exists()) {
            return;
        }
        (new \FluentCrm\App\Services\Funnel\FunnelProcessor())->startFunnelSequence($funnel, [], [
            'source_trigger_name' => 'anypress_crm',
            'source_ref_id' => 0,
        ], $contact);
    }

    /** A lead who confirms double opt-in starts the nurture series for the group they picked on the contact form. */
    public static function start_nurture($contact): void
    {
        $group = $contact ? trim((string) (((array) $contact->custom_fields())['customer_group'] ?? '')) : '';
        if ($group !== '') {
            self::start_automation("Nurture: $group", $contact);
        }
    }

    // ---- Contacts --------------------------------------------------------------------------------------------------

    /** The contact for an email, made "transactional" when new (buying or booking isn't a newsletter sign-up). */
    private static function contact(string $email, string $first = '', string $last = '')
    {
        $email = sanitize_email($email);
        if (!$email || !function_exists('FluentCrmApi')) {
            return null;
        }
        $contact = FluentCrmApi('contacts')->getContact($email);
        if ($contact) {
            return $contact;
        }
        return FluentCrmApi('contacts')->createOrUpdate(array_filter([
            'email' => $email,
            'first_name' => $first,
            'last_name' => $last,
            'status' => 'transactional',
        ])) ?: null;
    }

    private static function from_customer($customer)
    {
        return $customer && !empty($customer->email)
            ? self::contact((string) $customer->email, (string) ($customer->first_name ?? ''), (string) ($customer->last_name ?? ''))
            : null;
    }

    private static function from_user($userId)
    {
        $user = get_user_by('id', (int) $userId);
        return $user ? self::contact($user->user_email, (string) $user->first_name, (string) $user->last_name) : null;
    }

    private static function set_field($contact, string $key, string $value): void
    {
        if ($contact) {
            $contact->syncCustomFieldValues([$key => $value], false);
        }
    }

    /** Runs one event handler; a CRM step failing must never stop a checkout, a booking or a sign-up. */
    private static function safely(callable $step): void
    {
        try {
            $step();
        } catch (\Throwable $e) {
            error_log('AnyPress CRM lifecycle: ' . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- the site's log is where a failed step is looked into.
        }
    }

    // ---- FluentCart ------------------------------------------------------------------------------------------------

    private static function live_subscriptions($customerId, $exceptId = 0): int
    {
        return (int) \FluentCart\App\Models\Subscription::where('customer_id', $customerId)
            ->where('id', '!=', (int) $exceptId)
            ->whereIn('status', ['active', 'trialing', 'paused', 'failing', 'expiring', 'past_due'])
            ->count();
    }

    public static function on_subscription_active($data): void
    {
        self::safely(function () use ($data) {
            $sub = $data['subscription'] ?? null;
            if (!$sub) {
                return;
            }
            $contact = self::from_customer(($data['customer'] ?? null) ?: $sub->customer);
            self::add($contact, self::offering('subscription'), 'Active');
            self::set_field($contact, 'refunded', '');
        });
    }

    public static function on_subscription_end($data): void
    {
        self::safely(function () use ($data) {
            $sub = $data['subscription'] ?? null;
            if (!$sub || self::live_subscriptions($sub->customer_id, $sub->id)) {
                return; // Past only when the last plan ends
            }
            $contact = self::from_customer(($data['customer'] ?? null) ?: $sub->customer);
            if ($contact && !self::has($contact, self::offering('subscription'), 'Active') && self::refunded($contact)) {
                return; // a refund already took it back; it never really counted
            }
            self::add($contact, self::offering('subscription'), 'Past');
        });
    }

    /** One-off orders (no subscription in them) make the buyer "Shop: Past": bought once, nothing ongoing to end. */
    public static function on_order_paid($data): void
    {
        self::safely(function () use ($data) {
            $order = $data['order'] ?? null;
            if (!$order || in_array((string) $order->type, ['subscription', 'renewal'], true) || $order->subscriptions()->exists()) {
                return;
            }
            $contact = self::from_customer(($data['customer'] ?? null) ?: $order->customer);
            self::add($contact, self::offering('order'), 'Past');
            self::set_field($contact, 'refunded', '');
            if ($contact && empty(((array) $contact->custom_fields())['source'])) {
                self::set_field($contact, 'source', 'checkout');
            }
        });
    }

    /** A full refund takes the purchase back: Active goes, Past isn't added, and the contact is marked refunded. */
    public static function on_full_refund($data): void
    {
        self::safely(function () use ($data) {
            $order = $data['order'] ?? null;
            $customer = ($data['customer'] ?? null) ?: ($order ? $order->customer : null);
            $contact = self::from_customer($customer);
            if (!$order || !$contact) {
                return;
            }
            self::set_field($contact, 'refunded', 'yes');
            if ($order->subscriptions()->exists() || in_array((string) $order->type, ['subscription', 'renewal'], true)) {
                if (!self::live_subscriptions($customer->id)) {
                    self::remove($contact, self::offering('subscription'), ['Active']);
                }
                return;
            }
            $otherPaid = \FluentCart\App\Models\Order::where('customer_id', $customer->id)->where('id', '!=', $order->id)
                ->where('payment_status', 'paid')->exists();
            if (!$otherPaid) {
                self::remove($contact, self::offering('order'), ['Past']);
            }
        });
    }

    private static function refunded($contact): bool
    {
        return (((array) $contact->custom_fields())['refunded'] ?? '') === 'yes';
    }

    // ---- FluentBooking ---------------------------------------------------------------------------------------------

    private static function from_booking($booking)
    {
        return $booking && !empty($booking->email)
            ? self::contact((string) $booking->email, (string) ($booking->first_name ?? ''), (string) ($booking->last_name ?? ''))
            : null;
    }

    private static function upcoming_bookings($booking): int
    {
        return (int) \FluentBooking\App\Models\Booking::where('email', $booking->email)->where('id', '!=', $booking->id)
            ->whereIn('status', ['scheduled', 'pending'])->where('start_time', '>', gmdate('Y-m-d H:i:s'))->count();
    }

    public static function on_booking_scheduled($booking): void
    {
        self::safely(function () use ($booking) {
            $contact = self::from_booking($booking);
            self::add($contact, self::offering('booking'), 'Active');
            if ($contact && empty(((array) $contact->custom_fields())['source'])) {
                self::set_field($contact, 'source', 'booking');
            }
        });
    }

    public static function on_booking_completed($booking): void
    {
        self::safely(function () use ($booking) {
            $contact = self::from_booking($booking);
            self::add($contact, self::offering('booking'), 'Past');
            if (self::upcoming_bookings($booking)) {
                self::add($contact, self::offering('booking'), 'Active'); // another booking is still to come
            }
        });
    }

    /** A cancelled booking only ends Active (when nothing else is booked); it was never had, so no Past. */
    public static function on_booking_cancelled($booking): void
    {
        self::safely(function () use ($booking) {
            if (!self::upcoming_bookings($booking)) {
                self::remove(self::from_booking($booking), self::offering('booking'), ['Active']);
            }
        });
    }

    // ---- Contact form (Fluent Forms) -------------------------------------------------------------------------------

    /**
     * The site's contact form: the sender becomes a contact tagged "Enquiry: Interested" (or "Bookings: Interested"
     * when they asked for a booking), with the group they picked in the customer_group field. Asking a question isn't a
     * newsletter sign-up: a new contact is "transactional" unless they tick the newsletter box, which sends FluentCRM's
     * confirmation email; once they confirm, the nurture series for their group starts (start_nurture). Fluent Forms'
     * own FluentCRM feed isn't used for this because it subscribes new contacts without asking.
     */
    public static function on_contact_form($entryId, $formData, $form): void
    {
        self::safely(function () use ($formData, $form) {
            if (!$form || (int) $form->id !== (int) get_option('anypress_crm_contact_form') || !function_exists('FluentCrmApi')) {
                return;
            }
            $email = sanitize_email((string) ($formData['email'] ?? ''));
            if (!$email) {
                return;
            }
            $names = (array) ($formData['names'] ?? []);
            $wantsEmail = !empty($formData[self::FORM_NEWSLETTER]);
            $existing = FluentCrmApi('contacts')->getContact($email);
            $status = $existing ? $existing->status : ($wantsEmail ? 'pending' : 'transactional');
            if ($existing && $wantsEmail && in_array($existing->status, ['transactional', 'unsubscribed'], true)) {
                $status = 'pending'; // asked again, so they get the confirmation email again
            }
            $list = $wantsEmail ? \FluentCrm\App\Models\Lists::where('slug', 'newsletter')->first() : null;
            $contact = FluentCrmApi('contacts')->createOrUpdate(array_filter([
                'email' => $email,
                'first_name' => $existing && $existing->first_name ? '' : sanitize_text_field((string) ($names['first_name'] ?? '')),
                'last_name' => $existing && $existing->last_name ? '' : sanitize_text_field((string) ($names['last_name'] ?? '')),
                'status' => $status,
                'lists' => $list ? [$list->id] : [],
            ]));
            if (!$contact) {
                return;
            }
            $group = sanitize_text_field((string) ($formData[self::FORM_GROUP] ?? ''));
            if ($group !== '') {
                self::set_field($contact, 'customer_group', $group);
            }
            if (empty(((array) $contact->custom_fields())['source'])) {
                self::set_field($contact, 'source', 'contact_form');
            }
            $offering = ($formData[self::FORM_INTEREST] ?? '') === self::BOOKING_CHOICE && defined('FLUENT_BOOKING_VERSION')
                ? self::offering('booking') : self::offering('enquiry');
            if (!self::has($contact, $offering, 'Active') && !self::has($contact, $offering, 'Past')) {
                self::add($contact, $offering, 'Interested');
            }
            if ($contact->status === 'pending') {
                $contact->sendDoubleOptinEmail();
            } elseif ($contact->status === 'subscribed') {
                self::start_nurture($contact);
            }
        });
    }

    /** The "What can we help with?" choices: "A booking" only on sites that take bookings. */
    public static function form_choices($data, $form)
    {
        if (!$form || (int) $form->id !== (int) get_option('anypress_crm_contact_form')
            || ($data['attributes']['name'] ?? '') !== self::FORM_INTEREST || defined('FLUENT_BOOKING_VERSION')) {
            return $data;
        }
        $data['settings']['advanced_options'] = array_values(array_filter(
            (array) ($data['settings']['advanced_options'] ?? []),
            fn($option) => ($option['value'] ?? '') !== self::BOOKING_CHOICE
        ));
        return $data;
    }

    // ---- FluentCommunity -------------------------------------------------------------------------------------------

    public static function on_community_signup($userId): void
    {
        if (!self::$community_signup) {
            return;
        }
        self::$community_signup = false;
        self::safely(function () use ($userId) {
            $contact = self::from_user($userId);
            if ($contact && !self::memberships($userId, 'community') && !self::has($contact, self::offering('space'), 'Active')) {
                self::add($contact, self::offering('space'), 'Interested');
            }
        });
    }

    private static function memberships($userId, string $type): int
    {
        return (int) \FluentCommunity\App\Models\SpaceUserPivot::where('user_id', (int) $userId)->where('status', 'active')
            ->whereHas('space', fn($q) => $q->where('type', $type))->count();
    }

    public static function on_space_joined($space, $userId): void
    {
        self::safely(fn() => self::add(self::from_user($userId), self::offering('space'), 'Active'));
    }

    public static function on_space_left($space, $userId): void
    {
        self::safely(function () use ($userId) {
            if (!self::memberships($userId, 'community')) {
                self::add(self::from_user($userId), self::offering('space'), 'Past');
            }
        });
    }

    public static function on_course_enrolled($course, $userId): void
    {
        self::safely(fn() => self::add(self::from_user($userId), self::offering('course'), 'Active'));
    }

    public static function on_course_left($course, $userId): void
    {
        self::safely(function () use ($userId) {
            if (!self::memberships($userId, 'course')) {
                self::add(self::from_user($userId), self::offering('course'), 'Past');
            }
        });
    }

    // ---- FluentAffiliate -------------------------------------------------------------------------------------------

    /** Applied (pending): Interested. Approved: Active. Deactivated: Past. */
    public static function on_affiliate($affiliate): void
    {
        self::safely(function () use ($affiliate) {
            $contact = $affiliate ? self::from_user($affiliate->user_id) : null;
            $stage = ['pending' => 'Interested', 'active' => 'Active', 'inactive' => 'Past'][(string) $affiliate->status] ?? '';
            if ($stage !== '') {
                self::add($contact, self::offering('affiliate'), $stage);
            }
        });
    }

    // ---- Daily and weekly ------------------------------------------------------------------------------------------

    /** Interested for STALE_DAYS with no purchase: the interest has gone cold, so the tag goes. */
    public static function remove_stale_interest(): void
    {
        global $wpdb;
        $cutoff = gmdate('Y-m-d H:i:s', time() - self::STALE_DAYS * DAY_IN_SECONDS);
        foreach (\FluentCrm\App\Models\Tag::where('title', 'like', '%: Interested')->get() as $tag) {
            $ids = $wpdb->get_col($wpdb->prepare(
                "SELECT subscriber_id FROM {$wpdb->prefix}fc_subscriber_pivot WHERE object_type = %s AND object_id = %d AND created_at < %s LIMIT 500",
                'FluentCrm\App\Models\Tag',
                $tag->id,
                $cutoff
            ));
            foreach (\FluentCrm\App\Models\Subscriber::whereIn('id', array_map('intval', $ids))->get() as $contact) {
                $contact->detachTags([(int) $tag->id]);
                self::mirror($contact, [$tag->title], false);
            }
        }
    }

    /** The last 7 days, plus anything the monthly audit found, for the owner. */
    public static function weekly_numbers(): array
    {
        global $wpdb;
        $p = $wpdb->prefix;
        $since = gmdate('Y-m-d H:i:s', time() - 7 * DAY_IN_SECONDS);
        $count = fn(string $sql, ...$args) => (int) $wpdb->get_var($args ? $wpdb->prepare($sql, ...$args) : $sql);
        $byField = function (string $key) use ($wpdb, $p, $since) {
            $rows = $wpdb->get_results($wpdb->prepare(
                "SELECT m.value AS v, COUNT(*) AS n FROM {$p}fc_subscribers s JOIN {$p}fc_subscriber_meta m ON m.subscriber_id = s.id AND m.`key` = %s
                 WHERE s.created_at >= %s GROUP BY m.value ORDER BY n DESC",
                $key,
                $since
            ));
            return $rows ? implode(', ', array_map(fn($r) => ($r->v ?: 'not given') . ' ' . $r->n, $rows)) : 'none';
        };
        $lines = [
            'New contacts: ' . $count("SELECT COUNT(*) FROM {$p}fc_subscribers WHERE created_at >= %s", $since)
                . ' (subscribed to email: ' . $count("SELECT COUNT(*) FROM {$p}fc_subscribers WHERE created_at >= %s AND status = 'subscribed'", $since) . ')',
            'By group: ' . $byField('customer_group'),
            'By source: ' . $byField('source'),
        ];
        $moved = [];
        foreach (\FluentCrm\App\Models\Tag::where('title', 'like', '%: %')->get() as $tag) {
            $n = $count("SELECT COUNT(*) FROM {$p}fc_subscriber_pivot WHERE object_type = %s AND object_id = %d AND created_at >= %s", 'FluentCrm\\App\\Models\\Tag', $tag->id, $since);
            if ($n) {
                $moved[] = "{$tag->title} $n";
            }
        }
        $lines[] = 'Tags added this week (still held): ' . ($moved ? implode(', ', $moved) : 'none');
        if (class_exists('\FluentCart\App\Models\Subscription')) {
            $lines[] = 'Paid orders: ' . $count("SELECT COUNT(*) FROM {$p}fct_orders WHERE payment_status = 'paid' AND created_at >= %s", $since);
            $monthly = 0;
            foreach (\FluentCart\App\Models\Subscription::whereIn('status', ['active', 'trialing'])->get(['recurring_amount', 'billing_interval']) as $sub) {
                $months = ['yearly' => 12, 'half_yearly' => 6, 'quarterly' => 3, 'monthly' => 1, 'weekly' => 12 / 52, 'daily' => 12 / 365][$sub->billing_interval] ?? 1;
                $monthly += $sub->recurring_amount / 100 / $months;
            }
            $lines[] = 'Monthly revenue from live plans: ' . number_format($monthly, 2);
        }
        if ((int) gmdate('j') <= 7) {
            $lines = array_merge($lines, self::audit());
        }
        return $lines;
    }

    /** The monthly checks (crm-lifecycle-tagging, section 9). Only problems are listed. */
    public static function audit(): array
    {
        global $wpdb;
        $pivot = "{$wpdb->prefix}fc_subscriber_pivot";
        $found = [];
        $tags = \FluentCrm\App\Models\Tag::all();
        $byTitle = [];
        foreach ($tags as $tag) {
            $byTitle[$tag->title] = (int) $tag->id;
        }
        foreach ($byTitle as $title => $id) {
            if (!preg_match('/^(.+): Interested$/', $title, $m)) {
                continue;
            }
            $others = array_filter([$byTitle["{$m[1]}: Active"] ?? 0, $byTitle["{$m[1]}: Past"] ?? 0]);
            if (!$others) {
                continue;
            }
            $n = (int) $wpdb->get_var($wpdb->prepare(
                "SELECT COUNT(DISTINCT a.subscriber_id) FROM $pivot a JOIN $pivot b ON a.subscriber_id = b.subscriber_id AND b.object_type = a.object_type
                 WHERE a.object_type = %s AND a.object_id = %d AND b.object_id IN (" . implode(',', array_map('intval', $others)) . ')',
                'FluentCrm\App\Models\Tag',
                $id
            ));
            if ($n) {
                $found[] = "Audit: $n contacts have {$m[1]}: Interested as well as Active or Past.";
            }
        }
        foreach ($tags as $tag) {
            $members = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $pivot WHERE object_type = %s AND object_id = %d", 'FluentCrm\App\Models\Tag', $tag->id));
            if (!$members && strtotime((string) $tag->created_at) < time() - 60 * DAY_IN_SECONDS) {
                $found[] = "Audit: the tag \"{$tag->title}\" has had no contacts for 60 days; delete it if nothing will use it.";
            } elseif (!preg_match('/: (Interested|Active|Past)$/', $tag->title)) {
                $found[] = "Audit: \"{$tag->title}\" is outside the lifecycle tags; rename it to Offering: Stage or turn it into a field.";
            }
        }
        if ($found) {
            array_unshift($found, '', 'Monthly CRM check:');
        }
        return $found;
    }

    public static function email_weekly_numbers(): void
    {
        $to = (string) get_option('admin_email');
        if (!is_email($to) || substr($to, -8) === '.invalid') {
            return;
        }
        if (get_option('anypress_crm_weekly_email', 'yes') === 'no' || !self::busy_week()) {
            return; // switched off, or nothing happened: no empty email
        }
        $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES);
        wp_mail($to, "$name: this week's numbers", "The last 7 days on $name:\n\n" . implode("\n", self::weekly_numbers())
            . "\n\nYou get this every Monday there is something to report, from your website's CRM (FluentCRM).");
    }

    private static function busy_week(): bool
    {
        global $wpdb;
        $since = gmdate('Y-m-d H:i:s', time() - 7 * DAY_IN_SECONDS);
        return (bool) $wpdb->get_var($wpdb->prepare("SELECT 1 FROM {$wpdb->prefix}fc_subscribers WHERE created_at >= %s OR updated_at >= %s LIMIT 1", $since, $since));
    }
}

add_action('plugins_loaded', function () {
    if (defined('FLUENTCRM')) {
        AnyPress_CRM_Lifecycle::boot();
    }
}, 20);
