<?php
/**
 * The Online store demo: Thread & Co., a small clothing brand. The founders and their stylist write the journal,
 * and a monthly letter goes to customers and subscribers.
 *
 * Posts: [title, category, writer, image, body]. In a body, a blank line starts a paragraph, "## " a heading and
 * "- " a list item.
 */
return [
    'name' => 'Thread & Co.',
    'tagline' => 'Everyday clothes, made to last',
    'kinds' => ['order', 'enquiry'],
    'writers' => [
        ['Iris', 'Byrne', 'Co-founder. Designs every piece and still packs orders on Tuesdays.'],
        ['Malik', 'Mensah', 'Co-founder. Looks after the mills, the money and the customer emails.'],
        ['Tess', 'Reid', 'Stylist and photographer. Can make a plain t-shirt look like an outfit.'],
    ],
    'categories' => [
        'Style notes' => 'How to wear what we make, and what to wear it with.',
        'Behind the seams' => 'Mills, fabric and the people who make our clothes.',
        'Care guides' => 'How to make your clothes last for years.',
        'News' => 'New collections, sales and shop news.',
    ],
    'posts' => [
        ['How to choose the right hoodie size', 'Style notes', 2, 'hoodie', "Most returns we get are hoodies that fit a size off. Here is how to get it right first time.\n\n## Measure one you love\n\nLay your favourite hoodie flat. Measure armpit to armpit, and from the top of the shoulder to the hem. Compare those two numbers with the size chart on each product page.\n\n## Think about how you wear it\n\nOver a t-shirt only: take your normal size. Over a shirt or a thin jumper: go up one. If you are between sizes, our fleece softens and gives a little after a few washes."],
        ['Where our fleece comes from', 'Behind the seams', 1, 'yarn', "We buy our fleece from two family mills that we have visited ourselves. Both pay a fair wage, both recycle their water, and both have been making fabric for over forty years.\n\nIt costs us about a third more than the cheapest option. We think you can feel the difference the first time you put it on, and still feel it after fifty washes."],
        ['Five ways to wear a classic cap', 'Style notes', 2, 'hat', "Forward with a hoodie. Backwards on a hot day. With a jacket and jeans. Under a hood when it rains. Or not at all on a bad hair day, clipped to your bag.\n\nThe classic cap comes in four colours and fits most heads. The strap adjusts at the back."],
        ['How to wash fleece so it stays soft', 'Care guides', 0, 'laundry', "Fleece hates heat. Keep it away from hot washes and tumble dryers and it will last for years.\n\n- Turn it inside out\n- Wash at 30°C with similar colours\n- Skip the fabric softener; it flattens the fibres\n- Dry flat or on a hanger, away from the radiator\n\nIf it pills, a cheap fabric shaver takes it right back."],
        ['Packing an order, start to finish', 'Behind the seams', 0, 'packaging boxes', "Every parcel leaves the studio packed by hand. A normal Tuesday looks like this: orders printed at nine, folded and checked by eleven, tissue, a handwritten thank you, and recycled paper mailers.\n\nThe courier comes at three. If you order before two, it goes the same day."],
        ['Winter collection is live', 'News', 0, 'winter fashion', "Heavier fleece, two new colours and the return of the zipper hoodie. The winter collection is in the shop now.\n\nNew this season: forest green and a warm oatmeal, both in the classic hoodie and the fleece jacket."],
        ['Denim care: wash it less', 'Care guides', 1, 'jeans denim', "Raw denim gets better the less you wash it. Spot clean when you can, air it out overnight, and wash inside out in cold water every month or two.\n\nYour jeans will fade where you move, and that is the point. No two pairs end up the same."],
        ['The capsule wardrobe, our way', 'Style notes', 2, 'wardrobe clothes rack', "A capsule wardrobe does not have to be beige. Ours is fifteen pieces that all go together: two hoodies, three t-shirts, one jacket, two pairs of jeans, a pair of shorts, a cap, and a few things just for fun.\n\nStart with what you already wear every week. Replace things only when they wear out, with something that goes with the rest."],
        ['Meet the mill: a visit to Porto', 'Behind the seams', 1, 'textile', "In September we spent a week at the mill that weaves our t-shirt cotton. Three generations of one family, sixty looms, and a canteen that serves the best soup either of us has ever had.\n\nWe came back with two new fabrics to test and a lot of respect for how hard it is to make something simple well."],
        ['Free shipping weekend', 'News', 0, 'shopping bag', "This weekend only, shipping is free on every order. Use the code FREESHIP at checkout until Sunday at midnight."],
        ['What to wear to a winter market', 'Style notes', 2, 'christmas market', "Layers. A t-shirt, a hoodie and the fleece jacket over the top, so you can peel one off by the mulled wine stall. Add a cap for the cold and comfortable shoes for the cobbles."],
        ['Why we do not do Black Friday', 'News', 1, 'store window', "Every November we get asked about Black Friday. We do not do it, and here is why.\n\nOur prices are set so we can pay the mills fairly and still be here next year. A deep discount one week a year means higher prices the rest of it. Instead, our Sock club members get early access to new colours, and we give ten percent of November sales to a local textile school."],
        ['How to repair a small hole', 'Care guides', 0, 'sewing', "A small hole is not the end of a hoodie. With a needle, matching thread and ten minutes, you can close it so well you will forget where it was.\n\nTurn it inside out, pinch the hole closed and sew small stitches across it, a few millimetres past each edge. Knot it twice. Done.\n\nIf it is something you love, send it back to us and we will repair it for free in the first year."],
        ['Sock club: one year on', 'News', 1, 'socks', "A year ago we started the Sock club: a fresh pair every month, in a colour we pick. Today it has two hundred members and a waiting list for the striped ones.\n\nThank you. We have big plans for year two, including a pair designed by a member."],
        ['Styling one t-shirt five ways', 'Style notes', 2, 'tshirt fashion', "The white t-shirt is the hardest-working thing in your wardrobe. Under the fleece jacket, tucked into jeans, knotted over shorts, under a shirt, or on its own with a cap.\n\nWe shot all five on the same t-shirt in one afternoon. It still looks new."],
        ['The colours of the new season', 'Behind the seams', 0, 'colour fabrics', "We choose our colours a year ahead, from photos we take on walks. This season came from one rainy weekend in the Lake District: moss, slate and a deep loch blue.\n\nThey arrive in February. Newsletter readers will see them first."],
        ['Returns made simple', 'News', 1, 'package', "Changed your mind? You have sixty days to send it back. Print the label from your account, drop the parcel at any post office, and we refund the day it arrives.\n\nIf it is the wrong size, we can swap it instead and send the new one before yours arrives back."],
        ['Behind the photos: how we shoot the shop', 'Behind the seams', 2, 'photographer studio', "Every product photo is shot in our studio on the same grey wall, with the same window light, so the colours you see are the colours you get.\n\nThe model photos are friends, customers and occasionally our parents. Thank you to everyone who has stood very still in a fleece in July."],
    ],
    'drafts' => [
        ['Gift guide: under fifty dollars', 'News', 2, "Socks, the classic cap, a gift card, and the t-shirt. Still to add: photos and links."],
    ],
    'scheduled' => [
        ['Layering for the cold months', 'Style notes', 2, 'jacket', "A thin base, a warm middle and a jacket that blocks the wind. Here is how we layer our winter pieces so you stay warm without looking like a marshmallow."],
    ],
    'comments' => [
        'Measured my favourite hoodie like you said and the large fits perfectly.',
        'Love that you visit the mills yourselves.',
        'Will the forest green come back in medium?',
        'The washing tips saved my fleece, thank you!',
        'Ordered at 1pm and it arrived the next day. Amazing.',
        'Respect for skipping Black Friday.',
        'Just joined the Sock club!',
        'Can you do a post on caring for the cap?',
        'The handwritten note made my day.',
        'Repaired my hoodie with this guide. It worked!',
    ],
    'replies' => [
        'So happy it fits!',
        'Back in two weeks. Join the newsletter to hear first.',
        'Thank you, that means a lot to us.',
        'Great idea, it is on the list.',
        'Welcome to the club!',
    ],
    'messages' => [
        ['Wholesale', 'Something else', 'I run a boutique in Phoenix and would love to stock your hoodies. Do you sell wholesale?'],
        ['Size question', 'A question', 'Is the fleece jacket roomy enough to wear over a thick jumper?'],
        ['Order not arrived', 'A question', 'My order was meant to arrive Tuesday and has not come yet. Can you check?'],
        ['Collaboration', 'Something else', 'We are a small coffee roaster and think a joint gift box would be fun for the holidays.'],
        ['Gift wrapping?', 'A question', 'Can you gift wrap an order and leave the price out?'],
        ['Thank you', 'Something else', 'Three years in and my hoodie still looks new. Thank you for making things properly.'],
        ['Student discount', 'A question', 'Do you offer a student discount?'],
        ['Press enquiry', 'Something else', 'I write for a sustainability magazine and would love to interview you about your mills.'],
    ],
    'newsletter' => [
        'name' => 'The Thread',
        'every' => 30,
        'issues' => [
            ['Spring colours are here', 'Moss, slate and loch blue', 'The new colours are in the shop. They came from a rainy weekend in the Lake District, and we love them.'],
            ['Inside the mill', 'A week in Porto', 'This month: the family who weave our cotton, and two new fabrics we are testing.'],
            ['Summer layers', 'Plus free shipping this weekend', 'Light layers for long evenings, and free shipping until Sunday with FREESHIP.'],
            ['Your fleece, ten years from now', 'Care tips that work', 'A short guide to washing fleece so it stays soft, and a free repair offer for the first year.'],
            ['The winter collection', 'Heavier fleece and the zipper hoodie', 'The winter collection is live. Heavier fleece, forest green and oatmeal, and the zipper hoodie is back.'],
            ['Why we skip Black Friday', 'And what we do instead', 'No doorbusters here. Here is what we do instead, and how ten percent of November goes to a textile school.'],
        ],
        'next' => ['Gifts under fifty dollars', 'Our holiday gift guide', 'Socks, caps and gift cards: our favourite presents under fifty dollars, all shipped by Friday the 19th.'],
        'draft' => ['Holiday shipping dates', 'Order by these dates', 'The last days to order for delivery before the holidays. (Draft: confirm dates with the courier.)'],
        'welcome' => [
            [0, 'Welcome to Thread & Co.', 'Ten percent off your first order', '<p>Hi {{contact.first_name|there}},</p><p>Thank you for joining. Here is ten percent off your first order with the code WELCOME10.</p><p>Once a month you will get The Thread: new colours, care tips and a look behind the seams.</p><p>Iris and Malik</p>'],
            [3, 'How to find your size', 'The two-minute measuring trick', '<p>Hi {{contact.first_name|there}},</p><p>Measure a hoodie you already love, flat, armpit to armpit, and compare it with the size chart. It is the one trick that saves almost every return.</p><p>Tess</p>'],
            [7, 'Made to last', 'Why our clothes cost what they do', '<p>Hi {{contact.first_name|there}},</p><p>We pay our mills fairly, use fabric that lasts, and repair anything that breaks in the first year. That is the whole idea.</p><p>Malik</p>'],
        ],
    ],
    'form' => ['template' => 'customer_complaint_form', 'title' => 'Return or problem with an order'],
    'video' => 'How we make a hoodie',
    'snippet' => ['Free shipping notice', "add_action('wp_body_open', function () {\n    echo '<p class=\"shipping-notice\">Free shipping over \$75</p>';\n});"],
];
