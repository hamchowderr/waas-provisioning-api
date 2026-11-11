<?php
/**
 * The made-up business behind each site type's demo (business-<type>.php) and the people around it: customers,
 * readers, tickets, bookings, the community. All names are invented and every address is @example.com.
 */
return static function (string $type): array {
    // [first, last, city, company, bio]
    $people = [
        ['Maya', 'Chen', 'Portland', 'Chen Studio', 'Runs a small design studio. Coffee first, then pixels.'],
        ['Daniel', 'Okafor', 'Atlanta', '', 'Weekend woodworker turning a hobby into a shop.'],
        ['Sofia', 'Ramirez', 'Austin', 'Ramirez Catering', 'Caterer, mother of two, always planning the next menu.'],
        ['Liam', 'Walsh', 'Boston', '', 'Photographer. Mostly weddings, sometimes dogs.'],
        ['Aisha', 'Khan', 'Chicago', 'Khan & Co.', 'Bookkeeper by day, potter by night.'],
        ['Noah', 'Bennett', 'Denver', '', 'Trail runner who sells hand-drawn maps.'],
        ['Grace', 'Kim', 'Seattle', 'Kim Florals', 'Florist. Ask me about dried flowers.'],
        ['Lucas', 'Moreau', 'New Orleans', '', 'Musician and part-time music teacher.'],
        ['Hannah', 'Schmidt', 'Minneapolis', 'Northwind Yoga', 'Yoga teacher opening a second studio.'],
        ['Omar', 'Haddad', 'Detroit', '', 'Makes leather goods in a garage workshop.'],
        ['Chloe', 'Dubois', 'San Diego', 'Seaside Bakes', 'Baker. Sourdough is my love language.'],
        ['Ethan', 'Parker', 'Nashville', '', 'Writes songs, builds websites, drinks tea.'],
        ['Priya', 'Nair', 'San Jose', 'Nair Consulting', 'Helps small teams get their numbers right.'],
        ['Mateo', 'Silva', 'Miami', '', 'Personal trainer and smoothie enthusiast.'],
        ['Zoe', 'Thompson', 'Phoenix', 'Desert Bloom', 'Candle maker. Everything smells like sage.'],
        ['Ben', 'Carter', 'Columbus', '', 'Teacher learning to sell his lesson plans.'],
        ['Isla', 'Murphy', 'Pittsburgh', 'Murphy Print Co.', 'Screen printer with too many inks.'],
        ['Jonah', 'Levi', 'Philadelphia', '', 'Coach for first-time founders.'],
        ['Amara', 'Obi', 'Houston', 'Obi Textiles', 'Weaves fabric and stories.'],
        ['Ryan', 'Foster', 'Raleigh', '', 'Software tester, part-time baker.'],
        ['Elena', 'Petrova', 'Sacramento', 'Petrova Translations', 'Translator in four languages.'],
        ['Kai', 'Nakamura', 'Honolulu', '', 'Surf instructor and illustrator.'],
        ['Fatima', 'Ali', 'Dallas', 'Ali Events', 'Plans weddings and big birthdays.'],
        ['Owen', 'Price', 'Kansas City', '', 'BBQ judge and backyard pitmaster.'],
    ];

    // The business behind this site type (business-<type>.php): its name, writers, posts, newsletter and forms.
    $type = is_file(__DIR__ . '/business-' . $type . '.php') ? $type : 'website';
    $sample = require __DIR__ . '/business-' . $type . '.php';
    $sample['type'] = $type;
    $sample['blog'] = array_intersect_key($sample, array_flip(['writers', 'categories', 'posts', 'drafts', 'scheduled', 'comments', 'replies']));
    $sample['business'] = ['name' => $sample['name'], 'tagline' => $sample['tagline']];
    $sample['people'] = $people;
    // The rest of the mailing list: readers and customers who signed up over the months, without a story of their own.
    $firsts = ['Ava', 'Leo', 'Mia', 'Eli', 'Ruby', 'Max', 'Lena', 'Theo', 'Iris', 'Finn', 'Nina', 'Jude', 'Cleo', 'Rafael', 'Tess', 'Arjun', 'Lucy', 'Diego', 'Hazel', 'Sami', 'June', 'Felix', 'Rosa', 'Ivan', 'Esme', 'Malik', 'Wren', 'Tomas', 'Lila', 'Hugo', 'Anya', 'Kofi', 'Maeve', 'Dev', 'Clara'];
    $lasts = ['Brooks', 'Ito', 'Garcia', 'Novak', 'Reid', 'Mensah', 'Lund', 'Costa', 'Byrne', 'Sato', 'Patel', 'Keller', 'Duarte', 'Hayes', 'Okoro'];
    $cities = ['Portland', 'Austin', 'Denver', 'Chicago', 'Seattle', 'Boston', 'Atlanta', 'Phoenix', 'San Diego', 'Brooklyn', 'Oakland', 'Madison', 'Tucson', 'Richmond', 'Boise'];
    $sample['readers'] = [];
    for ($r = 0; $r < 76; $r++) {
        $sample['readers'][] = [$firsts[$r % count($firsts)], $lasts[($r + 7 * intdiv($r, 35)) % count($lasts)], $cities[($r * 2) % count($cities)], '', ''];
    }

    $sellsProducts = in_array($type, ['online-store', 'everything'], true);
    $takesBookings = in_array($type, ['bookings', 'everything'], true);
    $hasCommunity = in_array($type, ['community', 'everything'], true);

    // [person index, days ago, [[product index, quantity]], what happened]: six months of orders, busier lately, with
    // regulars who come back, two refunds, and the newest still being shipped or waiting for payment.
    $orders = [];
    $buyers = [0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 2, 9, 10, 4, 11, 12, 0, 13, 6, 14, 3, 18, 9, 19, 2, 22, 12, 0];
    $last = count($buyers) - 1;
    foreach ($buyers as $n => $who) {
        $lines = [[($n * 5) % 13, $n % 6 === 0 ? 2 : 1]];
        if ($n % 3 === 1) {
            $lines[] = [($n * 7 + 3) % 13, 1];
        }
        $outcome = $n === $last ? 'pending' : ($n >= $last - 3 ? 'processing' : ($n >= $last - 7 ? 'shipped' : (in_array($n, [5, 17], true) ? 'refunded' : 'paid')));
        $orders[] = [$who, round(178 * (1 - $n / $last) ** 1.35 + 0.4, 1), $lines, $outcome];
    }
    // The Everything demo has bookings and a community too; two orders in three keep its load time down.
    if ($type === 'everything') {
        $orders = array_values(array_filter($orders, static fn ($o, $n) => $n % 3 !== 1 || $n >= $last - 3, ARRAY_FILTER_USE_BOTH));
    }

    // [title, about, price in cents, how often it bills (once, month or year), photo, category]
    $sample['shop'] = $sellsProducts ? [
        // FluentCart's sample catalogue: three hoodies in several colours, and ten pieces with one photo each.
        'products' => [['menswear', 3], ['clothing', 10]],
        'categories' => ['Bottoms' => ['jeans', 'shorts', 'leggings'], 'Outerwear' => ['jacket'], 'Accessories' => ['cap'], 'Tops' => ['shirt', 'sweater', 'hoodie', 'sweatshirt', 'dress', 'nightgown']],
        'items' => [
            ['Sock club', 'A fresh pair of socks every month, in a colour we pick for you.', 1200, 'month', 'online-store/13.webp', 'Accessories'],
            ['Gift card', 'A gift card for anything in the shop, sent by email.', 5000, 'once', 'everything/17.webp', 'Accessories'],
        ],
        'coupons' => [['Welcome 10', 'WELCOME10', 'percentage', 10, 'First order'], ['Free shipping', 'FREESHIP', 'fixed', 8, 'Free shipping weekend']],
        'orders' => $orders,
        'subscribers' => [2, 6, 10],
    ] : [];
    // A business that sells its own things (vouchers, packs, memberships, a course) and no stock: months of orders
    // for them, regulars among the buyers, one refund and the newest waiting for payment.
    if (!$sample['shop'] && !empty($sample['sells'])) {
        $items = $sample['sells']['items'];
        $once = array_keys(array_filter($items, static fn ($i) => $i[3] === 'once'));
        $buyers = $sample['sells']['buyers'];
        $last = count($buyers) - 1;
        $orders = [];
        foreach ($buyers as $n => $who) {
            $outcome = $n === $last ? 'pending' : ($n === 6 ? 'refunded' : 'paid');
            $orders[] = [$who, round(170 * (1 - $n / $last) ** 1.3 + 0.5, 1), [[$once[($n * 3) % count($once)], 1]], $outcome];
        }
        $sample['shop'] = [
            'items' => $items,
            'coupons' => $sample['sells']['coupons'],
            'orders' => $orders,
            'subscribers' => $sample['sells']['subscribers'],
        ];
    }

    // [event index, person index, days ahead (negative: past), hour UTC, status]: three months of sessions, done,
    // a few no-shows and cancellations, and the next two weeks filling up.
    $bookings = [];
    $clients = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0, 1, 14, 18, 19, 22, 23, 2, 4, 6, 8, 3, 10, 12, 5, 9, 0, 7];
    foreach ($clients as $b => $who) {
        $status = $b % 11 === 7 ? 'no_show' : ($b % 9 === 4 ? 'cancelled' : 'completed');
        if ($type !== 'everything' || $b % 2) {
            $bookings[] = [[1, 2, 1, 0, 2, 1][$b % 6], $who, -(90 - $b * 3), 10 + ($b * 3) % 7, $status];
        }
    }
    foreach ([5, 6, 7, 8, 9, 10, 11, 12, 13, 2, 4, 6] as $u => $who) {
        $bookings[] = [[1, 2, 0, 1][$u % 4], $who, 1 + $u, 10 + ($u * 2) % 7, $u === 9 ? 'cancelled' : 'scheduled'];
    }

    $sample['bookings'] = $takesBookings ? [
        'hosts' => [
            [20, 'Massage therapist with ten years of practice.'],
            [21, $type === 'everything' ? 'Designer. Runs the one-to-one design sessions.' : 'Coach for small business owners.'],
        ],
        'events' => [
            // [host, title, minutes, price in cents (0 free), location, description]
            [0, 'Free 15-minute consultation', 15, 0, 'phone', 'A short call to talk through what you need.'],
            [0, '60-minute massage', 60, 8000, 'in_person', 'Full-body massage, pressure to suit you.'],
            $type === 'everything'
                ? [1, 'One-to-one design session', 45, 6500, 'online', 'Bring your idea, leave with a plan: a logo, a product or a shop.']
                : [1, 'Coaching session', 45, 9500, 'online', 'One focused session on the thing that matters most this month.'],
        ],
        'bookings' => $bookings,
    ] : [];

    // [person index, title, question, answers, state, days ago]
    $support = [
        'website' => [],
        'bookings' => [
            [13, 'Pregnancy massage?', 'Do you offer massage in the second trimester?', ['Yes, Elena is trained in pregnancy massage. Book the 60-minute massage and mention it in the notes.'], 'closed', 81],
            [9, 'Missed my session', 'I completely forgot my appointment yesterday. So sorry! Can I rebook?', ['No problem, it happens. I have put you in for next Tuesday at 2pm.'], 'closed', 58],
            [12, 'Receipt for my health plan', 'Could you send a receipt with your registration number for my claim?', ['Here it is, attached as a PDF. Hope the claim goes smoothly.'], 'closed', 34],
            [5, 'Do you sell gift vouchers?', "I'd like to buy one for my mum's birthday.", ['Yes! Reply with the amount and your mum\'s name and we will email a voucher today. They never expire.'], 'closed', 9],
            [3, 'Can I move my Thursday booking?', 'Something came up at work. Is there a slot on Friday instead?', ['Of course. I have moved you to Friday at 3pm and sent a new confirmation.'], 'waiting', 2],
            [18, 'Link for my coaching call', 'I cannot find the link for my coaching call tomorrow.', ['It is in your confirmation email, and I have just sent it again.'], 'waiting', 1],
            [7, 'Parking question', 'Is there parking near the studio?', [], 'new', 0.4],
        ],
        'online-store' => [
            [2, 'Kids sizes?', 'Do you make the hoodie in kids sizes?', ['Not yet, but it is on our list for spring!'], 'closed', 130],
            [12, 'Has my return arrived?', 'I sent a return back ten days ago. Has it arrived?', ['It arrived this morning and the refund is on its way. It takes 3 to 5 days to show.'], 'closed', 96],
            [10, 'New address for the Sock club', 'I moved last week. Can you update the address on my Sock club subscription?', ['Done. Your next pair goes to the new address.'], 'closed', 67],
            [8, 'Damaged in the post', 'The box arrived crushed and the cap is bent.', ['So sorry! A new cap is on its way, no need to send the old one back.'], 'closed', 41],
            [6, 'Thank you!', 'Just wanted to say the fleece is the best thing I own.', ['That made our day. Thank you for telling us!'], 'closed', 12],
            [4, 'Where is my order?', 'I ordered last week and have not had a shipping email yet.', ['Sorry for the wait! It left yesterday; your tracking number is in your account.'], 'waiting', 3],
            [14, 'Wholesale enquiry', 'I run a small boutique in Phoenix. Do you sell wholesale?', [], 'new', 1],
            [3, 'Wrong size, can I swap?', 'The hoodie is lovely but a bit small. Can I swap it for a large?', [], 'new', 0.5],
            [19, 'Discount code not working', 'WELCOME10 says it is not valid at checkout.', [], 'new', 0.2],
        ],
    ];
    $support['everything'] = $support['online-store'];
    $sample['tickets'] = $support[$type] ?? [];

    $sample['affiliates'] = $sellsProducts ? [
        // [person index, status, referrals: [order index, status]]
        [15, 'active', [[1, 'paid'], [4, 'unpaid'], [6, 'unpaid']]],
        [16, 'active', [[2, 'unpaid'], [9, 'pending']]],
        [17, 'pending', []],
    ] : [];

    $sample['community'] = $hasCommunity ? [
        // Everyone around the business, then readers who joined from the newsletter: [person index] or ['r', reader index].
        'members' => array_merge(range(0, 19), [22, 23], array_map(static fn ($r) => ['r', $r], range(0, 17))),
        'groups' => [
            ['Start here', [['Welcome', 'Say hello and tell us what brought you here.', 'public'], ['Introductions', 'Who you are and what you make.', 'public']]],
            ['Learn', [['Show your work', 'Share what you are making and get friendly feedback.', 'public'], ['Members only', 'Live Q&A notes, deals and the course chat.', 'private']]],
        ],
        // [author index (0 = the site's admin), space index, message, pinned]
        'feed' => [
            [0, 0, "Welcome, everyone! Introduce yourself below: who you are, what you make, and what you'd like to get from this community.", true],
            [1, 1, "Hi all, I'm Maya. I run a small design studio in Portland and I'm here to learn from people who've been where I am.", false],
            [2, 1, "Daniel here, from Atlanta. Woodworking on weekends, trying to make it more than a hobby.", false],
            [3, 2, "Finished my first big catering order this week. It took longer than planned, but I learned a lot. Happy to share notes.", false],
            [4, 0, "Is anyone else joining the live Q&A on Thursday? I have a few questions saved up about pricing.", false],
            [5, 2, "Here is a before and after of my product photos, shot with a phone and a white card. Feedback very welcome!", false],
            [6, 3, "Notes from last month's Q&A are up. The big one: raise your prices before you think you're ready.", true],
            [8, 1, "Hello from New Orleans! Musician and teacher. I want to sell my lesson plans.", false],
            [9, 2, "Second studio opens next month. Terrified and excited.", false],
            [10, 2, "Question: how do you all handle shipping costs for heavy items?", false],
            [11, 1, "Chloe, baker in San Diego. Sourdough subscriptions are my next project.", false],
            [4, 3, "Just finished lesson 4 of the course. The pricing worksheet alone was worth it.", false],
        ],
        'replies' => ['Great to see this here. Thanks for sharing!', 'This is really helpful, thank you.', 'Welcome! You will love it here.', 'Saving this one for later.', 'Love this. Keep going!'],
        'course' => [
            'title' => 'Start your shop in 30 days',
            'description' => 'Nine short lessons that take you from idea to first sale.',
            'sections' => [
                ['Week 1: Your idea', [['Pick one thing to sell', 'Start with the thing people already ask you for.'], ['Who is it for?', 'Write down three people you know who would buy it.'], ['Price it properly', 'Materials, time, a fair wage and a margin.']]],
                ['Week 2: Your shop', [['Photos that sell', 'Window light, a white card and a steady hand.'], ['Write a product page', 'What it is, who it is for, and why it is worth it.'], ['Set up checkout', 'Payments, shipping and the emails your customers get.']]],
                ['Week 3: Your first sale', [['Tell ten people', 'Your first customers are already in your phone.'], ['Ask for a review', 'A short, friendly email a week after delivery.'], ['What to do next', 'Keep what worked, drop what did not, and plan month two.']]],
            ],
            // [member index, lessons done]
            'students' => [[1, 9], [2, 5], [3, 3], [11, 4], [7, 0], [12, 9], [14, 6], [18, 2], [20, 1], [23, 7]],
            // Students' questions on a lesson they reached, each answered by the course lead: [lesson, member, question, answer]
            'questions' => [
                [0, 11, 'I make three different things. Do I really have to pick one?', 'For the first month, yes. Lead with the one people ask for most; the others can follow.'],
                [2, 1, 'Should I count my time if I only make things in the evenings?', 'Yes, always. Price as if this were your job, even if it is not yet.'],
                [2, 3, 'What margin do you add on top?', 'Most members start at 20 to 30 percent. It pays for the slow months and the next tool you need.'],
                [3, 2, 'My window faces north. Is that enough light?', 'North light is perfect: soft and even. Shoot in the middle of the day.'],
                [4, 14, 'How long should a product description be?', 'Long enough to answer what people ask at a market: size, materials, care. Usually 80 to 150 words.'],
                [5, 12, 'Which payment method should a first shop take?', 'Cards first; they cover almost every buyer. Add others when customers ask.'],
                [6, 23, 'Is it awkward to message friends about the shop?', 'A little, the first time. Keep it short, and ask who they know rather than whether they will buy.'],
            ],
        ],
    ] : [];

    return $sample;
};
