<?php
/**
 * The Everything demo: Brightline Studio, a design studio that sells clothes, takes bookings for classes and design
 * sessions, and runs a members' community with a course. Its team writes the journal and a monthly letter.
 *
 * Posts: [title, category, writer, image, body]. In a body, a blank line starts a paragraph, "## " a heading and
 * "- " a list item.
 */
return [
    'name' => 'Brightline Studio',
    'tagline' => 'Clothes, classes and a community for makers',
    'kinds' => ['order', 'booking', 'space', 'course'],
    'writers' => [
        ['Anya', 'Novak', 'Founder and designer. Started Brightline with one screen print and a borrowed table.'],
        ['Elena', 'Petrova', 'Teaches our massage and wellbeing sessions. Keeps the studio calm.'],
        ['Kai', 'Nakamura', 'Runs the design sessions and the members\' course. Illustrator.'],
    ],
    'categories' => [
        'Shop' => 'New pieces, restocks and how they are made.',
        'Classes' => 'What happens in our classes and sessions.',
        'Community' => 'Member stories and notes from the live Q&A.',
        'Studio life' => 'Behind the scenes at Brightline.',
    ],
    'posts' => [
        ['Our winter collection is here', 'Shop', 0, 'winter fashion', "Heavier fleece, two new colours and the return of the zipper hoodie. Every piece is printed in the studio and packed by hand.\n\nMembers got early access last week. Everyone else can shop it from today."],
        ['New: book a one-to-one design session', 'Classes', 2, 'design sketch', "Bring your idea, leave with a plan. Sessions are 45 minutes, online or in the studio, and cover logos, product design or a shop that looks like you.\n\nBook any weekday online. Members get one free session a quarter."],
        ['What to bring to your first class', 'Classes', 2, 'painting', "A notebook, a question and nothing else. We have aprons, inks, screens and coffee.\n\nClasses are small, six people at most, so everyone gets time at the press."],
        ['Member story: from market stall to online shop', 'Community', 0, 'market stall', "Omar sold his first wallet at a Sunday market. Two years later he ships every week, and he credits the course and the feedback in Show your work.\n\nRead his full story in the community, and say hello in Introductions."],
        ['How we print a hoodie', 'Shop', 0, 'printing', "Every design starts as a pencil sketch, becomes a stencil on a mesh screen, and is pressed one colour at a time. A two-colour hoodie takes about four minutes at the press, plus a day to cure.\n\nIt is slower than digital printing. It also lasts as long as the hoodie does."],
        ['Live Q&A every first Thursday', 'Community', 2, 'video call', "Bring your questions. We cover pricing, photos, shipping, and whatever members are stuck on that month.\n\nWe record every call for members who cannot make it. Notes go up in the Members only space the next day."],
        ['Massage for makers: undo the workshop hunch', 'Classes', 1, 'massage', "Hours at a bench or a press add up in your shoulders and lower back. Our 60-minute massage focuses on exactly that.\n\nBook it as a reward after a busy market weekend. Your hands will thank you too."],
        ['A day in the studio', 'Studio life', 0, 'studio workspace', "Coffee at eight. Orders packed by ten. A class at eleven, design sessions after lunch, and the press running until five.\n\nOn Fridays we close early, sweep up, and plan the week ahead with whatever is left in the biscuit tin."],
        ['Free shipping weekend', 'Shop', 0, 'shopping bag', "Use FREESHIP at checkout until Sunday night. Every order ships in recycled paper with a handwritten thank you."],
        ['The course: Start your shop in 30 days', 'Community', 2, 'laptop', "Nine short lessons that take you from idea to first sale, free for members. Each lesson ends with a task you can finish in an evening.\n\nForty members have finished it so far. Twelve have made their first sale."],
        ['Behind the design: the mountain print', 'Shop', 2, 'mountain illustration', "Our best-selling print started on a hike. Kai sketched the ridge on the back of a receipt, and three versions later it became the mountain hoodie.\n\nThe new colourway, slate on oatmeal, is in the winter collection."],
        ['How to look after printed clothes', 'Shop', 0, 'laundry', "Wash inside out at 30°C, skip the tumble dryer, and never iron directly on the print. Follow those three and the print will outlast the fabric."],
        ['Group bookings for teams', 'Classes', 1, 'workshop', "Bring your team for a printing afternoon. Up to twelve people, everyone takes home a tote they printed themselves.\n\nGreat for birthdays, team days and hen parties. Get in touch to book a date."],
        ['Members helping members', 'Community', 0, 'people community', "This month in the community: a member found a cheaper courier and shared the discount, two members are sharing a stall at the winter market, and someone finally solved the sticky screen problem.\n\nThis is why we built it."],
        ['Studio sale this Saturday', 'Studio life', 0, 'store window', "Seconds, samples and last season's colours, up to half price, in the studio this Saturday from ten. First come, first served, and there will be cake."],
        ['How we choose our colours', 'Studio life', 2, 'paint', "We pick each season's colours from photos we take on walks. This winter: moss, slate and a warm oatmeal from one foggy weekend by the sea."],
        ['Gift vouchers for classes and sessions', 'Classes', 1, 'gift box', "Give a printing class, a design session or a massage. Vouchers never expire and can be sent by email in minutes."],
        ['A year of Brightline', 'Studio life', 0, 'celebration', "One year ago we opened the doors. Since then: four hundred orders, sixty classes, two hundred members and one very tired press.\n\nThank you for every order, booking and post. Here is to year two."],
    ],
    'drafts' => [
        ['Holiday opening hours', 'Studio life', 0, "Closed 24 December to 1 January. Last orders for delivery before the holidays: the 18th. (Confirm courier dates.)"],
    ],
    'scheduled' => [
        ['Winter classes are open for booking', 'Classes', 2, 'snow', "Printing classes on Saturdays through February, and two new evening sessions on Wednesdays. Book early: they fill up."],
    ],
    'comments' => [
        'The design session was worth every minute.',
        'Loved the printing class, already booked another.',
        'The mountain hoodie is my favourite thing I own.',
        'Can I join the Q&A if I am not a member yet?',
        'Will there be another studio sale before Christmas?',
        'Booked a team afternoon for March!',
        'The course got me to my first sale. Thank you!',
        'Happy birthday, Brightline!',
        'The massage after market weekend is now a tradition.',
        'Love seeing how the prints are made.',
    ],
    'replies' => [
        'Thank you, see you soon!',
        'Members only, but the first month is free.',
        'Yes, in early December. Watch the newsletter.',
        'We cannot wait to see what you print.',
        'That makes us so happy.',
    ],
    'messages' => [
        ['Team printing afternoon', 'A booking', 'We are a team of ten. Could we book a printing afternoon in March?'],
        ['Wholesale hoodies', 'Something else', 'We run a shop in Seattle and would love to stock the mountain hoodie.'],
        ['Membership and classes', 'A question', 'Do members get a discount on classes, or only the design sessions?'],
        ['Size swap', 'A question', 'My hoodie is a bit small. Can I swap it for a large?'],
        ['Custom print for our club', 'Something else', 'Could you print 30 hoodies with our running club logo?'],
        ['Thank you', 'Something else', 'The class was the highlight of my month. Thank you!'],
        ['Gift voucher', 'A question', 'Can I buy a voucher for a massage and a class together?'],
        ['Press visit', 'Something else', 'I write for a local paper and would love to visit the studio for a feature.'],
    ],
    'newsletter' => [
        'name' => 'Studio Notes',
        'every' => 30,
        'issues' => [
            ['Spring at the studio', 'New classes and a new colour', 'Spring classes are open, and a new colour arrives in the shop next week.'],
            ['The course is live', 'Start your shop in 30 days', 'Our members\' course is live: nine lessons from idea to first sale.'],
            ['Summer printing days', 'Bring a friend, print a tote', 'Long evenings at the press. Book a summer class and bring a friend for half price.'],
            ['Inside the press room', 'How a hoodie is made', 'A look at how one hoodie goes from a sketch to your door.'],
            ['Winter collection, members first', 'Early access starts now', 'Members, the winter collection is yours a week early. Everyone else, next Thursday.'],
            ['A year of Brightline', 'Thank you', 'One year, four hundred orders, sixty classes. Thank you for being part of it.'],
        ],
        'next' => ['Studio sale and winter classes', 'Saturday from ten', 'Seconds and samples at half price this Saturday, and winter classes are open for booking.'],
        'draft' => ['Holiday gift guide', 'Hoodies, classes and vouchers', 'Our gift guide for every budget. (Draft: add photos and voucher links.)'],
        'welcome' => [
            [0, 'Welcome to Brightline Studio', 'Shop, book and join', '<p>Hi {{contact.first_name|there}},</p><p>Welcome! You can shop our printed clothes, book a class or session, and join the members\' community, all in one place.</p><p>Here is ten percent off your first order: WELCOME10.</p><p>Anya</p>'],
            [3, 'Try a class', 'Six people, one press', '<p>Hi {{contact.first_name|there}},</p><p>Our printing classes are small and friendly, and you take home what you print. Book one online any time.</p><p>Kai</p>'],
            [7, 'Join the community', 'Makers helping makers', '<p>Hi {{contact.first_name|there}},</p><p>Our members share their work, ask questions and take the course together. The first month is free.</p><p>Anya</p>'],
        ],
    ],
    'form' => ['template' => 'customer_complaint_form', 'title' => 'Return or problem with an order'],
    'video' => 'Inside the studio',
    'snippet' => ['Free shipping notice', "add_action('wp_body_open', function () {\n    echo '<p class=\"shipping-notice\">Free shipping over \$75</p>';\n});"],
    // The public pages: [section title, items] and buttons as [label, page slug, '#anchor' or 'portal'].
    'pages' => [
        // The hero's photo: the blog post whose photo it uses.
        'photo' => 12,
        'hero' => 'Clothes, classes and a community for makers. Shop our printed clothes, book a class or a design session, and join the members.',
        'buttons' => [['Shop', 'shop'], ['Book a session', '#book']],
        'products' => 'From the shop',
        'features' => ['Three ways in', [
            ['Shop', 'Hoodies, tees and totes, printed in the studio one colour at a time.'],
            ['Book', 'Printing classes, one-to-one design sessions with Kai and massage with Elena.'],
            ['Join', 'A members\' community with a course that takes you from idea to first sale.'],
        ]],
        'blog' => ['Journal', 'From the journal'],
        'signup' => ['Studio Notes', 'Once a month: new prints, open classes and member news. Ten percent off your first order.'],
        'faq' => ['Good to know', [
            ['Where is the studio?', 'Portland, Oregon. Classes and sessions happen here, or online.'],
            ['Do members get discounts?', 'Members get one free design session a quarter and early access to new prints.'],
            ['Do you ship outside the US?', 'Not yet. Free shipping in the US on orders over $75.'],
        ]],
        'cta' => ['Join the members', 'Share your work, take the course and come to the live Q&A. The first month is free.', [['Join the community', 'portal']]],
        'about' => ['The story of Brightline Studio', [
            'Anya started Brightline with one screen print and a borrowed table. The prints sold, people asked to learn how they were made, and the classes followed.',
            'Today the studio prints and ships clothes, teaches small classes, runs design sessions with Kai and massage with Elena, and hosts a community of makers who learn together.',
        ], [
            ['Made here', 'Every print is pressed in the studio, one colour at a time.'],
            ['Small classes', 'Six people at most, so everyone gets time at the press.'],
            ['Makers helping makers', 'Members share what works, from couriers to colours.'],
        ]],
        'contact' => [['Email', 'hello@brightline.example'], ['Phone', '(503) 555-0187, Tuesday to Saturday, 10am to 5pm.'], ['Studio', '22 Alder Street, Portland, Oregon.']],
    ],
];
