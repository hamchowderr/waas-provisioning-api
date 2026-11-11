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

    $sample['shop'] = $sellsProducts ? [
        // FluentCart's sample catalogue: three hoodies in several colours, and ten pieces with one photo each.
        'products' => [['menswear', 3], ['clothing', 10]],
        'categories' => ['Bottoms' => ['jeans', 'shorts', 'leggings'], 'Outerwear' => ['jacket'], 'Accessories' => ['cap'], 'Tops' => ['shirt', 'sweater', 'hoodie', 'sweatshirt', 'dress', 'nightgown']],
        'subscription' => ['Sock club', 'A fresh pair of socks every month, in a colour we pick for you.', 1200],
        'gift' => ['Gift card', 'A gift card for anything in the shop, sent by email.', 5000],
        'coupons' => [['Welcome 10', 'WELCOME10', 'percentage', 10, 'First order'], ['Free shipping', 'FREESHIP', 'fixed', 8, 'Free shipping weekend']],
        // [person index, days ago, [[product index, quantity]], what happened]
        'orders' => [
            [0, 29, [[0, 1]], 'paid'], [1, 27, [[3, 2]], 'paid'], [2, 25, [[5, 1], [3, 1]], 'paid'],
            [3, 22, [[1, 1]], 'refunded'], [4, 20, [[7, 1]], 'paid'], [5, 17, [[2, 1]], 'shipped'],
            [6, 15, [[4, 2]], 'paid'], [7, 12, [[10, 1]], 'paid'], [8, 10, [[6, 1]], 'shipped'],
            [9, 8, [[8, 1], [5, 1]], 'paid'], [10, 6, [[11, 1]], 'paid'], [11, 4, [[9, 1]], 'shipped'],
            [0, 3, [[5, 2]], 'processing'], [12, 2, [[0, 1]], 'processing'], [13, 1, [[3, 1]], 'pending'],
        ],
        'subscribers' => [2, 6, 10],
    ] : [];

    $sample['bookings'] = $takesBookings ? [
        'hosts' => [
            [20, 'Massage therapist with ten years of practice.'],
            [21, 'Coach for small business owners.'],
        ],
        'events' => [
            // [host, title, minutes, price in cents (0 free), location, description]
            [0, 'Free 15-minute consultation', 15, 0, 'phone', 'A short call to talk through what you need.'],
            [0, '60-minute massage', 60, 8000, 'in_person', 'Full-body massage, pressure to suit you.'],
            [1, 'Coaching session', 45, 9500, 'online', 'One focused session on the thing that matters most this month.'],
        ],
        // [event index, person index, days ahead (negative: past), hour UTC, status]
        'bookings' => [
            [1, 2, -9, 14, 'completed'], [2, 3, -6, 16, 'completed'], [0, 4, -3, 10, 'completed'],
            [1, 5, 1, 15, 'scheduled'], [0, 6, 1, 11, 'scheduled'], [2, 7, 2, 17, 'scheduled'],
            [1, 8, 3, 14, 'scheduled'], [2, 9, 4, 16, 'scheduled'], [0, 10, 5, 10, 'scheduled'],
            [1, 11, 6, 15, 'scheduled'], [2, 12, 2, 13, 'cancelled'], [1, 13, 8, 14, 'scheduled'],
        ],
    ] : [];

    $support = [
        'website' => [],
        'bookings' => [
            [3, 'Can I move my Thursday booking?', 'Something came up at work. Is there a slot on Friday instead?', ['Of course. I have moved you to Friday at 3pm and sent a new confirmation.'], 'waiting'],
            [5, 'Do you sell gift vouchers?', "I'd like to buy one for my mum's birthday.", ['Yes! You can buy them on the Services page, and they never expire.'], 'closed'],
            [7, 'Parking question', 'Is there parking near the studio?', [], 'new'],
        ],
        'online-store' => [
            [3, 'Wrong size, can I swap?', 'The hoodie is lovely but a bit small. Can I swap it for a large?', [], 'new'],
            [4, 'Where is my order?', 'I ordered last week and have not had a shipping email yet.', ['Sorry for the wait! It left yesterday; your tracking number is in your account.'], 'waiting'],
            [14, 'Wholesale enquiry', 'I run a small boutique in Phoenix. Do you sell wholesale?', [], 'new'],
            [6, 'Thank you!', 'Just wanted to say the fleece is the best thing I own.', ['That made our day. Thank you for telling us!'], 'closed'],
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
        'members' => range(0, 11),
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
            [7, 1, "Hello from New Orleans! Musician and teacher. I want to sell my lesson plans.", false],
            [8, 2, "Second studio opens next month. Terrified and excited.", false],
            [9, 2, "Question: how do you all handle shipping costs for heavy items?", false],
            [10, 1, "Chloe, baker in San Diego. Sourdough subscriptions are my next project.", false],
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
            'students' => [[1, 9], [2, 5], [3, 3], [11, 4], [7, 0]],
        ],
    ] : [];

    return $sample;
};
