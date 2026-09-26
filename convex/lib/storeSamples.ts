import type { StoreBot } from "./store";

// The Bot Store's sample bots (convex/lib/store.ts): they stand in until the
// owner lists a bot of their own (Settings → Bot Store → Manage), so the
// store is never empty. They sell like any other bot, and whoever buys one
// keeps it, and its memory, after they go. Their memory is in this public
// code, which is fine for samples; the owner's bots live in the database.
// Each one's `about` is its page in the store, in Markdown (src/ui/store.js
// BotPage): about 1,000 words on what it does for you, with nothing on how
// it works inside.

const sample = (bot: Omit<StoreBot, "price" | "listed" | "featured"> & { featured?: boolean }): StoreBot => ({
  price: 1000,
  listed: true,
  featured: false,
  ...bot,
});

export const SAMPLE_BOTS: StoreBot[] = [
  sample({
    slug: "sample-chef",
    name: "Chef Remy",
    tagline: "Weekly meal plans and a shopping list built around you",
    about: `Dinner shouldn't take more thinking than cooking does. Chef Remy plans your week of meals around the people at your table, the time you really have and the food you love, then turns the plan into one tidy shopping list. When it's time to cook, it's right there with you, one clear step at a time.

## Your week, planned in minutes

Tell Chef Remy who you're cooking for and what your week looks like, and it hands back a plan that fits: five to seven dinners, plus breakfasts and lunches if you want them. Busy Tuesday? That's a 20-minute stir-fry. Slow Sunday? Maybe a roast chicken that becomes Monday's tacos.

Every plan is built around you:

- **Your tastes.** The cuisines you love, the foods you'd rather skip, and how adventurous you feel this week.
- **Your diet.** Vegetarian, vegan, halal, kosher, gluten-free, dairy-free, low-carb or anything in between.
- **Your allergies.** Checked in every recipe, every time, including the sneaky ones, like sesame in a dressing or nuts in a pesto.
- **Your time.** Weeknight dinners in 30 minutes or less, most in one pan or one pot. Bigger projects wait for the weekend.
- **Your budget.** Beans, eggs, seasonal vegetables, whole chickens and the freezer aisle do the heavy lifting when money is tight.

Each day is balanced without being preachy: a protein, a vegetable or two and something hearty, with enough variety that no two nights feel the same.

## One shopping list, in the order you shop

No more scraps of paper and a forgotten onion. Chef Remy writes a single list for the whole week, grouped the way stores are laid out: produce, meat and fish, dairy and eggs, bakery, pantry and frozen. Quantities are added up across recipes, so you see "3 onions", not three separate lines. Staples you probably have, like oil, salt and common spices, are marked "check the pantry", so you don't come home with a fourth jar of cumin.

Want the list somewhere handy? Chef Remy can save the plan and the list as a file, or email the list to you or whoever's doing the shopping once your email is connected. You see exactly what's going out before it goes.

## A patient cook at your side

Cooking with Chef Remy feels like having a friend in the kitchen who has made the dish a hundred times. Recipes list the ingredients and amounts first, then short, numbered steps with times and temperatures in both Fahrenheit and Celsius. It tells you what "done" looks like, so you're never guessing: golden at the edges, a skewer that comes out clean, a sauce that coats the back of a spoon.

Stuck halfway through? Just ask:

- **Out of buttermilk?** Milk and a squeeze of lemon, ready in five minutes.
- **Cooking for six instead of four?** Every amount, scaled.
- **Only one clean pan?** It rewrites the steps around it.
- **Is the chicken done?** 165°F (74°C) in the thickest part, and here's how to check.

## Less waste, better leftovers

Chef Remy plans the way good home cooks do: cook once, eat twice. Extra rice from Monday becomes Wednesday's fried rice. Half a bunch of cilantro doesn't wilt in the drawer, because it's back in a recipe by midweek. Sunday's roasted vegetables fill Tuesday's lunch wraps. Nothing gets bought for one meal and forgotten.

It keeps you safe along the way, too: cooked food shouldn't sit out for more than two hours, and most leftovers keep three to four days in the fridge. And when you're staring into the fridge wondering what's possible, send Chef Remy a photo. It suggests what to make tonight with what you already have.

## For busy weeks and big occasions

Some weeks call for a plan within the plan. Chef Remy can map out a Sunday meal-prep session that sets you up for the days ahead: what to cook first, what to chop in advance, what keeps well and what's best made fresh. Hosting? Tell it how many are coming and what they can't eat, and it plans a menu that works together, with a timeline counting back from when you want to sit down, so everything lands hot at the same time. Holiday feasts, birthday cakes, a picnic for twelve: it plans them all, right down to the shopping list.

## It gets to know your table

Tell Chef Remy what everyone loved and what nobody touched, and next week's plan shifts to match. Your partner can't stand mushrooms? They quietly disappear. The kids went back for seconds of the lemon pasta? Expect it again soon. Week by week, it starts to feel like your own family cookbook, one that never runs out of ideas.

Ask it to plan the coming week every Saturday morning and it will, without being reminded, so the plan and the list are ready before you shop.

## Try asking

> Plan five dinners for two, vegetarian, nothing over 30 minutes.

> What can I make tonight with chicken thighs, a lemon and some rice?

> I have $60 for groceries this week. Feed a family of four.

> Turn Sunday's roast chicken into two lunches.

> My friend is gluten-free. Rework Friday's dinner so it's safe for her.

## Getting started

1. Tell Chef Remy who you cook for, any allergies, and how much time you usually have on weeknights. It asks about anything else it needs.
2. Ask for your first week, and swap out anything you don't fancy: just say so.
3. Take the list shopping, and open the chat when it's time to cook.

## Good to know

- Chef Remy checks every recipe against the allergies you've told it about, but read labels too, especially for severe allergies.
- It's a cook, not a doctor. For a medical diet, such as for diabetes or kidney disease, follow your doctor's or dietitian's advice, and Chef Remy plans around it.
- Prices and what's in season depend on where you live, so it plans with typical prices and tells you when it's estimating.`,
    category: "food",
    shape: "blob",
    color: "orange",
    thinking: "jelly",
    featured: true,
    order: 1,
    highlights: [
      "Plans 5–7 dinners a week around your tastes, diet and budget",
      "One shopping list for the week, grouped by aisle",
      "Weeknight recipes in 30 minutes or less",
      "Plans leftovers into lunches so little goes to waste",
      "Swaps for allergies and missing ingredients",
    ],
    rules: "Always check recipes against the allergies I've told you about.\nKeep weeknight recipes to 30 minutes unless I ask for more.",
    memory: `You are a meal-planning chef. Your job: plan the user's meals for the week, make the shopping list, and help them cook with confidence.

How you plan
- Start from the user: who's eating, allergies and intolerances, diet (vegetarian, halal, keto…), foods they dislike, cooking skill, time on weeknights, kitchen equipment and weekly budget. Ask once for what you don't know, then remember it.
- A week is 5–7 dinners unless they say otherwise, plus breakfasts and lunches if asked. Balance each day: a protein, a vegetable or two, and a starch or whole grain.
- Weeknights: 30 minutes or less, one pan or one pot where possible. Save longer recipes for weekends.
- Cook once, eat twice: plan leftovers into lunches, and reuse ingredients across the week (half a bunch of cilantro on Monday means cilantro again by Wednesday) so little goes to waste.
- Rotate cuisines and proteins so the week doesn't repeat. Respect the budget: lean on beans, eggs, seasonal produce, whole chickens and frozen vegetables when money is tight.

The shopping list
- One list for the week, grouped by store section: produce, meat and fish, dairy and eggs, bakery, pantry, frozen, other.
- Combine quantities across recipes ("3 onions", not three lines of one). Mark what they probably have already (salt, oil, common spices) as "check the pantry".
- Offer to save the plan and the list as a file, or to email the list, when those tools are connected.

Recipes
- Ingredients with amounts, then short numbered steps with times and temperatures (°F and °C). Say what "done" looks like.
- Scale servings on request. Offer swaps for missing ingredients and for allergies.
- Food safety always: safe internal temperatures (poultry 165°F/74°C, ground meat 160°F/71°C, fish 145°F/63°C), leftovers keep 3–4 days in the fridge, and cooked food never sits out over 2 hours.

Keep an eye on
- Ask at the weekend whether they want next week's plan, and offer a routine for it (every Saturday morning).
- Note what they loved or skipped, and plan around it next time.`,
  }),
  sample({
    slug: "sample-travel",
    name: "Atlas",
    tagline: "Plans your trips to the hour, on your budget",
    about: `Atlas turns "we should go to Lisbon" into a trip you can't wait to take. It shapes the route, plans each day around neighborhoods so you see more and travel less, keeps a running budget, and stays with you on the road, ready to change plans when the weather does.

## From daydream to plan

Start with as much or as little as you know: a city, a season, or just an itch to see mountains. Atlas asks what a great travel agent would: when you can go, who's coming, what you love, how fast you like to move and what you want to spend. Then it sketches the shape of the trip:

- **Where to go, and for how long.** Which cities or regions, how many nights in each, and why.
- **How to get between them.** Trains, flights, buses or a rental car, with honest travel times.
- **Where to stay.** The neighborhoods that suit your style, with the upsides and the catches of each.
- **What to book early.** The restaurants, tours and tickets that sell out, flagged well ahead.

It keeps the moving around sensible, usually no more than once every two or three nights, unless you ask for a whirlwind.

## Days that flow

Every day gets a morning, an afternoon and an evening, grouped by neighborhood so you're not zigzagging across town. Each day has one anchor, like a museum slot, a hike or a special dinner, and plenty of room to wander, get a little lost and find the café you'll talk about for years.

Atlas fills in the details that make a day actually work:

- Opening days and hours, so you don't arrive at a museum on its day off
- Travel times between stops, on foot or by public transport
- Typical costs for meals, transport and entry, in the local currency and in yours
- A rainy-day swap for every outdoor plan

## Every kind of trip

A long weekend in a city, a two-week road trip, a honeymoon, a family holiday with a toddler, a work trip with one free afternoon: Atlas plans each a little differently. Traveling with kids? It builds in naps, playgrounds and early dinners. With someone who can't manage stairs? It checks access before it suggests a place. On a tight budget? It finds the free museum days, the good-value neighborhoods and the lunch menus that cost half the price of dinner. Going for the food? The whole day is planned around the meals.

## Checked, not guessed

Prices, opening hours, strikes, entry rules and the weather all change. Atlas looks things up on the web as your dates get closer, tells you where it found them, and says plainly when a number is an estimate.

It also keeps an eye on the essentials that trip people up: passport validity (many countries want six months left on it), visas and travel authorizations, travel insurance and vaccinations. It tells you what to check, and points you to the official government sites to confirm it.

## A budget that keeps up

As the plan grows, Atlas keeps a running total by flights, places to stay, getting around, food and activities, with a 10% cushion for the surprises every trip brings. Wondering whether that splurge dinner fits? Ask, and it shows you what it does to the total.

Choosing between two hotels, or between the train and a flight? It compares them side by side on price, time, comfort and flexibility, and points out the catch in a basic fare or a non-refundable room before you commit.

## Local know-how

Atlas helps you fit in wherever you go: how tipping works, what to wear to visit a temple, which days the shops close, how to buy a transit card, and a handful of useful phrases in the local language, with how to say them. Small things, but they turn a tourist's day into a traveler's day.

## Your whole trip, in one place

Atlas keeps a trip file with everything that matters: the day-by-day plan, the confirmation numbers you share with it, addresses, check-in times and local emergency numbers. With your email connected, it can find your booking confirmations and add them for you. Traveling with others? It can put the whole plan in a file that's easy to share.

## On the road

Plans meet reality. When it pours, a museum is shut or your feet give up, tell Atlas where you are, and it suggests something nearby that fits. Its answers are short and practical, made for reading on a street corner: what to do, how to get there and how long it takes. Missed a train? It works out the next best way to get where you're going. Found a place you love? It reworks tomorrow so you can go back. Ask for a quick plan each morning of the trip, and it will have one ready.

## Try asking

> Plan 10 days in Portugal in May for two, mid-range budget, not too rushed.

> Should we take the train from Paris to Barcelona, or fly?

> What should we book now for Tokyo in April?

> It's raining in Edinburgh. What's good indoors near the Old Town?

> Keep our whole trip under $4,000, flights included.

## Getting started

1. Tell Atlas where you're dreaming of, roughly when, and who's coming. No destination yet? Tell it what you love, and it suggests a few.
2. Look over the shape of the trip and adjust it: more beach, fewer cities, a slower pace.
3. Get your day-by-day plan and your list of what to book, then book it on your own terms.

## Good to know

- Atlas never books or pays for anything itself. It prepares the options, and you make the bookings.
- Entry and visa rules change, so always confirm them on official government sites before you go.
- Prices are what it found when it checked. They move, flights especially, so it tells you when a number is an estimate.`,
    category: "travel",
    shape: "cloud",
    color: "teal",
    thinking: "float",
    featured: true,
    order: 2,
    highlights: [
      "Day-by-day itineraries grouped by neighborhood",
      "A running budget by flights, stays, food and activities",
      "Checks opening hours, tickets, weather and entry rules",
      "Honest comparisons of flights, trains and places to stay",
      "Adjusts your plans on the go",
    ],
    rules: "Never book or pay for anything without my OK.\nAlways give prices in my own currency too.",
    memory: `You are a travel planner. Your job: plan trips that fit the user's time, budget and style, and keep them organized before and during the trip.

Before planning, know: where and when (or how flexible the dates are), who's going, the budget (total or per day), the pace (packed or relaxed), interests (food, museums, nature, nightlife, shopping), how they like to stay (hotel, apartment, hostel), mobility needs, and their passport or visa situation. Ask for the missing essentials in one message.

How you plan
- Start with the shape of the trip: which cities or areas, how many nights in each, and how they'll get between them. Avoid moving more than once every 2–3 nights unless they want a whirlwind.
- Day plans: morning, afternoon and evening, grouped by neighborhood to cut travel time, with one anchor a day (a museum booking, a hike, a special dinner) and room to wander. Note opening days and hours, and what needs tickets booked ahead.
- Give realistic times and costs: travel time between places, and typical prices for meals, transport and entry, in the local currency and theirs. Say when a price is an estimate.
- Use web search to check current opening hours, prices, events, strikes, weather and entry rules; say where the information came from and when it may change.
- Budget: keep a running total by category (flights, stays, transport, food, activities, and a 10% buffer).

Getting there and staying
- Compare options honestly: price, time, comfort and flexibility. Point out the catches of basic fares and non-refundable stays.
- Never book, buy or enter payment details yourself: prepare the options and let the user book, unless they clearly tell you to and the tools allow it with their approval.

Documents and safety
- Remind them to check passport validity (many countries want 6 months), visas or travel authorizations, travel insurance and vaccinations, and to confirm them on official government sites.
- Keep a trip file: the itinerary, confirmation numbers the user gives you, addresses and emergency numbers.

During the trip, adjust plans for weather or closures, suggest nearby alternatives, and keep answers short and practical.`,
  }),
  sample({
    slug: "sample-inbox",
    name: "Inbox Zero",
    tagline: "Sorts your email and drafts replies in your voice",
    about: `Your inbox is full of things that want a piece of you. Inbox Zero goes through it with you, tells you what really needs you, and writes replies that sound like you wrote them. You stay in charge the whole time: nothing is sent, forwarded or deleted without your OK.

## What needs you, first

Inbox Zero reads your new mail and tells you what's in it, sorted into four simple piles:

- **Reply needed.** People who are waiting to hear from you.
- **Decide.** Approvals, invitations and questions only you can answer.
- **Read later.** Newsletters, updates and anything worth a look when you have a minute.
- **Done.** Receipts, notifications and everything with nothing left to do.

Every email that needs you comes with a one-line summary: who it's from, what they want and by when. Anything urgent, and anything from the people who matter most to you, goes to the top. Instead of reading forty emails to find the three that matter, you read three lines.

## Replies in your voice

Inbox Zero learns how you write from the mail you've sent: how you say hello and sign off, how long your emails usually are, and how formal you are with a client compared with a friend. Then it drafts replies that sound like you on a good day: clear, friendly and to the point.

- It answers the question, says what happens next and makes one clear ask.
- When the tone is delicate, like turning something down, chasing a late payment or pushing back on a deadline, it offers two versions: one a little firmer, one a little warmer.
- You read the draft, change anything you like, and give the word. Only then does it go.

It writes new emails, too. Give it a line, like "ask Priya to move Thursday's meeting to Friday", and it turns that into a proper email, ready for your OK.

## Nothing slips through

It's easy to send an email that needs an answer and then forget all about it. Inbox Zero doesn't. When you send something that's waiting on a reply, it keeps track, and if nothing comes back in a few days, it reminds you and offers a friendly nudge you can send. It keeps an eye on the promises in your inbox, too: the report you said you'd send by Friday, the form someone asked you to sign. Those go on the list.

Ask for a morning summary, and each day starts with a short briefing: what came in overnight, who's waiting on you and what can wait. Two minutes over coffee, and you know exactly where you stand.

## A day with Inbox Zero

At eight in the morning, your summary is waiting: four emails need replies, one needs a decision, and the rest can wait. You approve two drafts over breakfast and change a word in the third. By lunch, it has noticed that the client you wrote to last Tuesday hasn't answered, and has a short, friendly nudge ready. In the evening you ask what's still open, and the answer is one thing. Tomorrow starts clean.

## Find anything, fast

When did the flight leave again? What did the landlord say about the deposit? Ask Inbox Zero. It searches your mail and answers the question, with the email the answer came from, so you don't have to dig. It can gather everything about one topic, too: a project, a trip, a purchase or a person. Or ask it to pull out every receipt from last month for your expenses.

## Safer, calmer email

Some emails aren't what they seem. Inbox Zero flags the ones that look like phishing or scams, like urgent payment demands, look-alike sender addresses and "confirm your password" links, and it never clicks or acts on them. It tells you what looks wrong, so you learn to spot the signs yourself.

It helps you get less email in the first place, too. It notices the newsletters you never open and offers to help you unsubscribe, and it spots the mail that arrives every week, so you can decide what to do with it once instead of every time.

## Clean-ups without the worry

When you ask it to clear things out, Inbox Zero shows you exactly which emails it means before anything happens. Deleted mail goes to the trash, where you can get it back, unless you clearly tell it to delete something for good. Changed your mind? Ask it to put them back.

## Your inbox, your rules

Everyone runs their email differently. Tell Inbox Zero how you like it, like "anything from my kids' school is urgent", "invoices go to Read later" or "I don't answer email on weekends", and it sorts, summarizes and reminds you your way, every time.

## Works with Gmail and Outlook

Connect your Gmail or Outlook account once, in Settings under Plugins, and Inbox Zero is ready to go. You can disconnect any time.

## Try asking

> What needs my reply today?

> Summarize everything from this week that I haven't read.

> Draft a polite no to Sam's conference invitation.

> Who hasn't gotten back to me since Monday?

> Find the newsletters I never open and help me unsubscribe.

## Getting started

1. Connect Gmail or Outlook in Settings, under Plugins.
2. Say hello to Inbox Zero and ask it to go through your inbox. It shows you the piles, and what needs you first.
3. Ask for a morning summary and a follow-up check, and let it keep you at zero.

## Good to know

- Inbox Zero never sends, replies to, forwards or deletes an email without showing you first.
- Your email stays yours. It uses what it reads only to help you, and never shares your details.
- It won't click links or open attachments in suspicious emails, and it tells you why it's wary.`,
    category: "productivity",
    shape: "squircle",
    color: "blue",
    thinking: "scan",
    featured: true,
    order: 3,
    highlights: [
      "Sorts new mail into reply, decide, read later and done",
      "One-line summaries of what each email needs from you",
      "Drafts replies in your own voice, for your OK",
      "Tracks follow-ups and reminds you when nobody answers",
      "Spots phishing and scams before you click",
    ],
    rules: "Never send, reply to, forward or delete an email without showing me first.",
    memory: `You are an email assistant. Your job: help the user get to, and stay at, a clean inbox, and write replies that sound like them.

Triage
- When the user's Gmail or Outlook is connected, go through new mail and sort it into: Reply needed (people waiting on them), Decide (approvals, invitations, questions only they can answer), Read later (newsletters, updates) and Done (receipts, notifications, anything with nothing to do).
- Summarize each "Reply needed" and "Decide" email in one line: who, what they want, and by when. Put anything urgent, or from the people who matter most to them, first.
- Flag what looks like phishing or a scam (urgent payment requests, odd sender addresses, login links), and never click or act on it.

Replies in their voice
- Learn their style from their sent mail when you can: greeting, sign-off, length, tone, and how formal they are with whom.
- Keep drafts short: answer the question, say the next step, make one clear ask. Offer two versions when the tone is delicate (firmer and friendlier).
- Never send, reply, forward or delete without the user's OK on that exact email, unless they've told you exactly what to send. Show the draft first.

Keeping it clean
- Suggest unsubscribing from newsletters they never open, and filters for mail that comes every week.
- Track follow-ups: when they send something that needs an answer, note it, and remind them if nothing comes back in a few days. Offer a daily routine: a morning summary of what came in and what's waiting on them.
- Delete only what they meant, to the trash (where it can be restored) unless they say "for good".

Privacy: their email is theirs. Don't copy personal details anywhere else unless the task needs it, and never share them.`,
  }),
  sample({
    slug: "sample-coach",
    name: "Coach Kai",
    tagline: "Workouts and habits that fit your week",
    about: `Coach Kai is the coach who shows up for you, whether you have a full gym or ten minutes on the living-room floor. It builds workouts around your real week, explains every move in plain words, and cares more about you showing up than about how hard you go.

## A plan that fits your life

Most fitness plans fail because they were built for someone else's schedule. Coach Kai starts with yours: your goals, the days and minutes you really have, the equipment you can get to, what you enjoy, and anything that hurts or holds you back. Then it builds your week:

- **Two to five sessions,** each with a warm-up, the main work and a cool-down, and proper rest days in between.
- **Strength** built on the big, useful movements: squats, hinges, pushes, pulls and carries, each with an easier and a harder version.
- **Cardio** that's mostly comfortable, at a pace where you can still hold a conversation, with harder intervals once you've built a base.
- **Mobility** to keep your hips, back and shoulders happy, especially if you sit all day.

At home with no equipment? Every exercise comes in a bodyweight version, and a backpack full of books makes a surprisingly good weight. Only have a kettlebell and a jump rope? You get a plan for that, too.

## Whatever your goal

Getting stronger, losing fat, running your first 5K, keeping up with your kids, moving without aches, or just feeling better than you did last month: Coach Kai shapes the plan around what you want, and tells you honestly what it will take and how long. Training for something specific, like a hike, a race or a ski trip? It counts back from the date and builds you up to it, week by week. Just starting out? It begins gently, so the first weeks feel doable, not punishing.

## Every move, explained

You shouldn't need a video to understand an exercise. Coach Kai explains each one in two or three simple cues, like "feet shoulder-width apart, chest up, sit back as if there's a chair behind you", along with the most common mistake to avoid. Not sure a move feels right? Describe what you're feeling, and it helps you fix it, or suggests a variation that suits your body better.

It can put each session in a simple list you can follow on your phone between sets, with the reps, the rest times and the cues right there.

## Progress you can feel

Coach Kai moves you forward slowly and steadily. Once every set of an exercise feels solid, it adds a rep or a little weight. Weeks that go well build on each other. Weeks that don't are no big deal: it adjusts and keeps you moving. Over a couple of months, it adds up: the stairs feel easier, you sleep better, and the weights that felt heavy start to feel light.

Tell it how each session went, and it keeps track of your numbers for you, so you can look back and see how far you've come.

## Small habits, big difference

What you do outside your workouts matters just as much as what you do in them. Coach Kai helps you build a few small habits that stick, one or two at a time:

- A ten-minute walk after lunch
- A glass of water before your morning coffee
- Some protein with every meal
- A regular bedtime, even on weekends

Small and specific beats big and vague. You won't get strict diets or calorie spreadsheets, just simple targets that make each day a little better than the last.

## A week with Coach Kai

Monday, 30 minutes of strength before work. Tuesday, a brisk walk at lunch. Wednesday, rest, with a short stretch before bed. Thursday, strength again, a little heavier than last time. Saturday, a longer walk or a bike ride with a friend. On Sunday evening, a two-minute check-in on how the week went, and next week's plan is ready before Monday comes around.

## Check-ins that keep you going

Once a week, Coach Kai checks in: what went well, what got in the way and what to change. Busy week coming up? It trims the plan so you can still show up. Traveling? It writes a workout for the hotel room. Missed a whole week? It starts from where you are now, not where you were, without a word of guilt. Ask it to remind you on workout days, and it will.

Its tone is encouraging and honest, never shaming. It celebrates showing up more than it celebrates sweat, because consistency is what really changes things.

## Try asking

> Build me a 3-day plan with just dumbbells, 40 minutes a session.

> I have 15 minutes and no equipment. What should I do?

> My knee hurts on lunges. What can I do instead?

> Help me get to 8,000 steps a day without it taking over my life.

> I've been off for a month. Ease me back in.

## Getting started

1. Tell Coach Kai your goal, how many days a week you can train, how long you have, and what equipment you've got. Mention any injuries or conditions.
2. Get your first week, with every exercise explained. Try it, then tell it how it felt.
3. Set up a weekly check-in, and let it adjust the plan as you go.

## Good to know

- Coach Kai is a coach, not a doctor. If you have a medical condition, are pregnant, or are coming back from an injury or a long break, check with your doctor first, and it keeps things conservative.
- Mention pain and it changes the plan to avoid it. Sharp pain, dizziness or chest pain means stop and get medical help.
- For a detailed nutrition plan, it suggests a registered dietitian.`,
    category: "health",
    shape: "pill",
    color: "green",
    thinking: "hop",
    order: 4,
    highlights: [
      "Weekly plans for strength, cardio and mobility",
      "Home, gym or no-equipment versions of every move",
      "Small habits for sleep, steps, water and protein",
      "Weekly check-ins that adjust your plan",
    ],
    rules: "Always include a warm-up and a cool-down.\nIf I mention pain, change the plan to avoid it.",
    memory: `You are a personal fitness and habits coach. Your job: build workouts and habits that fit the user's week, and keep them going.

Start by learning: their goals (strength, fat loss, endurance, mobility, general health), current activity, experience, injuries or conditions, equipment (gym, home, none), how many days and minutes a week they really have, and what they enjoy. If they mention pain, a medical condition, pregnancy, or starting after a long break, suggest checking with a doctor first, and keep things conservative.

Programs
- Plan by the week: 2–5 sessions, each with a warm-up (5 minutes), the main work and a cool-down. Include rest days.
- Strength: compound moves first (squat, hinge, push, pull, carry), 2–4 sets of 6–12 reps, with an easier option for each. Progress slowly: add a rep or a little weight once every set feels solid.
- Cardio: mostly easy (they can hold a conversation), with some harder intervals once a base is built.
- Home or no equipment: bodyweight and backpack versions of every exercise.
- Explain each exercise in 2–3 cues, and the most common mistake to avoid.

Habits
- Small and specific beats big and vague: "a 10-minute walk after lunch", not "move more". One or two habits at a time.
- Sleep, protein, water and steps matter as much as workouts: give simple targets, not strict diets. Don't write medical nutrition plans; suggest a registered dietitian for those.
- Offer routines: a reminder on workout days, and a weekly check-in (what went well, what got in the way, what to change).

Tone: encouraging and honest, never shaming. Missed a week? Start from where they are now, not where they were. Celebrate consistency more than intensity.

Never push through sharp pain, dizziness or chest pain: tell them to stop and get medical help.`,
  }),
  sample({
    slug: "sample-budget",
    name: "Penny",
    tagline: "Budgets, bills and savings goals, sorted",
    about: `Money gets less stressful the moment you can see it clearly. Penny shows you where your money goes, builds a budget you can actually keep, and makes a plan for every goal, from a starter emergency fund to next summer's trip. It's calm, practical and free of judgment, and it always shows its math.

## A budget built from your real numbers

Forget the template that assumes you spend exactly $400 on groceries. Penny starts with your life: your take-home pay and how often it arrives, your fixed bills, your usual spending, and any savings and debts. From there, it builds a monthly budget that fits the way you really live.

Not sure where to begin? Penny can suggest a simple approach:

- **50/30/20.** Half for needs, 30% for wants, and 20% for saving and paying down debt. A good starting point for most people.
- **Zero-based.** Every dollar gets a job before the month begins. More hands-on, for people who want more control.

Paid irregularly, as a freelancer or in tips? Penny builds the budget around your leanest month, and plans what to do with the good ones.

## See where it all goes

Paste in a list of transactions, attach a CSV file exported from your bank, or send a photo of a receipt. Penny sorts your spending into clear categories, like housing, groceries, transport, eating out and subscriptions, and shows you:

- What you spent in each category this month
- How that compares with last month
- Where you went over budget, and by how much

No more wondering where the money went. You get a clear picture, and a few practical ideas for the categories that surprised you.

## Never miss a bill

Penny keeps a calendar of your bills: rent or mortgage, utilities, insurance, your phone, loan payments and every subscription. Ask it to remind you a few days before each one is due, and it will, so late fees become a thing of the past.

It's a sharp-eyed auditor, too. It spots the subscriptions you've forgotten about (that streaming trial from last spring), charges that look doubled, and prices that crept up without a word.

## Goals with a plan

Wanting to save is easy. Knowing how much to put aside each month is what makes it happen. For every goal, Penny works out the amount, the date and the monthly figure it takes:

1. **An emergency fund first:** a starter $1,000, then three to six months of essential costs.
2. **Then your goals:** a trip, a new laptop, a deposit on a home, a wedding.
3. **Progress you can see:** where you are, what's left and whether you're on track.

When life happens and a goal slips, Penny works out the new monthly amount, or the new date, so you can pick the one that suits you.

## A clear way out of debt

If you're paying off debt, Penny lists every balance and interest rate, and explains your two main options in plain words:

- **Avalanche.** Pay off the highest interest rate first. You pay the least interest overall.
- **Snowball.** Pay off the smallest balance first. You get quick wins that keep you going.

It shows both side by side, with the dates and the totals, and you choose. Either way, you'll know the month you'll be debt-free.

## A month with Penny

At the start of the month, you set the budget together in ten minutes. A few days before each bill, a reminder. Midway through, a quick check: groceries are on track, eating out is running hot, and there's still room for Friday's dinner if you skip one takeout. At the end of the month, a short review: what went well, what to adjust and how much closer you are to your goals. Fifteen minutes a month, and no more money mysteries.

## Big decisions, thought through

Thinking about a new car, a move or a new job? Penny helps you think it through: what it really costs each month, what it does to your goals, and what to ask before you decide. Rent or buy, lease or finance, new or used: it lays out the numbers side by side, so you choose with clear eyes.

## Math you can trust

Penny does the arithmetic carefully and shows its work, so you can check every number. For anything more than simple sums, like a loan payoff schedule or the effect of an extra $50 a month, it runs the numbers in code rather than guessing.

## Money talks, made easier

Money is often a shared job. Penny can help you split bills fairly with a partner or roommates, plan a group trip's costs, or put together a simple monthly summary to go through together, so the conversation starts from the same numbers.

## Try asking

> Here's last month's spending. Where did it all go?

> Build me a budget on $4,200 a month take-home.

> How much do I need to save each month to have $3,000 by June?

> Should I pay off my credit card or my car loan first?

> Which of my subscriptions am I not using?

## Getting started

1. Tell Penny your monthly take-home pay and your fixed bills. Rough numbers are fine to begin with.
2. Share a month of spending: paste it in, attach a CSV file from your bank, or type the big items.
3. Get your budget, your bill calendar and a plan for your first goal.

## Good to know

- Penny never moves money or pays anything. It helps you plan, and you stay in control of your accounts.
- It never asks for passwords, full card or account numbers, or security codes, and you never need to share them.
- Penny helps with budgeting, not regulated financial, tax or investment advice. For those, it explains the basics and suggests a licensed professional.`,
    category: "money",
    shape: "circle",
    color: "purple",
    thinking: "nod",
    order: 5,
    highlights: [
      "A monthly budget built from your real numbers",
      "Sorts your spending and compares it month to month",
      "Bill reminders before every due date",
      "Savings and debt plans with the monthly amount each takes",
      "Finds forgotten subscriptions and odd charges",
    ],
    rules: "Never move money or pay a bill.\nAlways show your math.",
    memory: `You are a personal budgeting assistant. Your job: help the user see where their money goes, plan for bills and goals, and make steady progress.

Getting started
- Ask for take-home income (and how often it comes), fixed bills (rent or mortgage, utilities, insurance, phone, subscriptions, loan payments and their rates), usual spending (groceries, transport, eating out, shopping), savings and debts.
- Build a monthly budget from that. Offer a simple method: 50/30/20 (needs, wants, saving and debt) as a starting point, or zero-based (every dollar given a job) for people who want more control.

What you do
- Sort the spending the user shares (statements, lists, receipts) into categories, and show totals by category, the change from last month, and where the budget went over.
- Keep a bill calendar: what's due when. Offer a routine that reminds them a few days before each due date.
- Savings goals: an emergency fund first (a starter $1,000, then 3–6 months of essential costs), then their own goals, each with an amount, a date and the monthly amount it takes.
- Debt: list balances and rates, and explain avalanche (highest rate first, least interest) and snowball (smallest balance first, quick wins); let them choose.
- Spot subscriptions they don't use, and charges that look wrong or doubled.
- Do the math carefully and show it; use the code sandbox for anything beyond simple arithmetic.

Boundaries
- You help with budgeting, not regulated financial, tax, legal or investment advice. For investments, taxes or big decisions, explain the basics and suggest a licensed professional.
- Never ask for or keep passwords, full card or account numbers, or security codes. Never move money or pay anything.

Tone: calm, practical and free of judgment. Small wins count.`,
  }),
  sample({
    slug: "sample-sales",
    name: "Pitch",
    tagline: "Finds leads and writes outreach that gets replies",
    about: `Pitch is the sales assistant that does your homework. It learns what you sell and who it's for, finds the people and companies that fit, gives you a reason to reach out to each one now, and writes short, personal messages that sound human. Then it keeps every follow-up on track. Nothing goes out without your OK.

## It starts with your offer

Great outreach starts with knowing exactly what you're offering, and to whom. Pitch asks what you sell, who it's for (the industry, the company size and the role of the person who buys), the problem it solves, the proof you have (results, clients, numbers), your price range, and what you want from each conversation: a reply, a call or a demo. That becomes the foundation for everything it writes.

## Prospects worth your time

Pitch searches the web and public pages to build lists of companies and people who fit, and for each one it looks for a reason to reach out now:

- **Hiring.** They just posted a role your product would make easier.
- **Funding.** Fresh money usually means new projects.
- **A launch or a new location.** Growth brings new problems to solve.
- **A public pain point.** A complaint, a review or a post that your offer answers.

It all goes into a simple table: name, role, company, why now, the source link and where things stand. Pitch never guesses email addresses or invents facts. Anything it couldn't confirm, it marks as unknown. Already have a list of companies? Give it to Pitch, and it researches each one and adds the reason to reach out.

## Messages that get replies

Nobody reads long cold emails. Pitch writes short ones, 50 to 120 words, with one idea each:

1. **A personal first line** that shows you actually looked: their company, a recent post, the news.
2. **The problem,** in their words rather than yours.
3. **One line of proof:** a result, a client or a number.
4. **One easy ask,** like "Worth a 15-minute call next week?"

Subject lines are two to five words and read like a person wrote them, never like clickbait. LinkedIn messages are shorter still. For calls, you get a 20-second opener and ready answers to the questions people usually ask.

## Follow-ups that don't feel pushy

Most replies come after the second or third email, not the first. Pitch writes the whole sequence: the first email, then two or three follow-ups three to five business days apart, each adding something new, like a short case study, an idea for their business or a good question. The last is a polite note that closes the loop. People respect it, and plenty reply to that one.

## Objections, answered

"Not right now." "It's too expensive." "Just send me some info." Pitch helps you answer the objections you hear most, honestly and without pressure, with replies that keep the conversation going instead of ending it. Tell it what a prospect said, and it suggests a response, and the next step.

## Your pipeline, in order

Pitch keeps track of who replied, what they said and the next step for each. Ask for a list each morning of the follow-ups due that day, and you'll never lose a warm lead to a busy week again. It can keep a weekly scorecard too, of emails sent, replies and calls booked, so you see what's working. With Gmail or Outlook connected, it can have your emails ready to send, and check your inbox for replies.

## Walk into every call prepared

Got a meeting tomorrow? Ask Pitch for a one-page brief: what the company does, its recent news, who you're meeting and their background, what they probably care about, and three smart questions to ask. You walk in prepared, and it shows.

## A morning with Pitch

You open the chat with your coffee. Three prospects replied overnight: one wants a call, one asked about pricing and one said not now. Pitch has drafted an answer to each, and five follow-ups due today are ready for your OK. By nine, your outreach for the day is done, and you're on the phone with the one who wants to talk.

## Better every week

Pitch learns what works for you. Tell it which emails got replies and which fell flat, and it adjusts the angle, the length and the ask. Over time, you build a playbook of the messages that work for your market, and your outreach gets sharper with every week.

## For founders, freelancers and sales teams

Whether you're a founder doing sales between everything else, a freelancer finding your next client, or part of a sales team that wants more time for real conversations, Pitch takes on the research and the first drafts, so you can spend your time on the people who answer.

## Try asking

> Here's what we sell. Find 20 companies that fit, with a reason to reach out to each.

> Write a first email to the operations lead at a 50-person logistics company.

> Turn this into a 4-email sequence.

> They said "send me some info". How should I reply?

> Which follow-ups are due today?

## Getting started

1. Tell Pitch what you sell, who buys it and why it's worth buying. Share a result or two if you have them.
2. Ask for a first list of prospects, and pick the ones you like.
3. Review the first emails, change anything you want, and send them when you're happy.

## Good to know

- Pitch never sends anything without your OK, and never invents facts about a prospect.
- It follows the rules of the road for outreach: a real sender, an easy way to opt out, honest subject lines, and opt-outs honored at once.
- Its research comes from public sources, and it tells you where each fact came from.`,
    category: "business",
    shape: "triangle",
    color: "red",
    thinking: "sparkle",
    order: 6,
    highlights: [
      "Prospect lists with a reason to reach out to each",
      "Short, personal emails and follow-up sequences",
      "Answers to the objections you hear most",
      "A daily list of follow-ups that are due",
    ],
    rules: "Never send outreach without my OK.\nNever invent facts about a prospect.",
    memory: `You are a sales outreach assistant. Your job: help the user find the right prospects, write outreach that gets replies, and keep follow-ups on track.

First learn the offer: what they sell, who it's for (industry, company size, the buyer's role), the problem it solves, proof (results, clients, numbers), the price range, and the goal of the outreach (a call, a demo, a reply).

Prospecting
- Build lists of companies and roles that fit, using web search and public pages; note why each fits now (a trigger: hiring, funding, a launch, a new location, a public complaint the offer solves).
- Keep a simple table: name, role, company, why now, source link, status. Never guess or invent emails or facts; mark what's unknown.

Writing outreach
- Short: 50–120 words, one idea per email. A personal first line that shows you looked (their company, a post, the news), then the problem, one line of proof, and one easy ask ("Worth a 15-minute call next week?").
- Subject lines: 2–5 words; lower case feels human; no clickbait.
- Sequences: the first email and 2–3 follow-ups, 3–5 business days apart, each adding something new (a case study, an idea, a question), and a polite last one that closes the loop.
- LinkedIn messages: shorter still. Calls: a 20-second opener, and answers to the most common objections.

Following up
- Track who replied, what they said and the next step; suggest replies to objections (timing, price, "send me some info").
- Offer a routine: each morning, the follow-ups due that day.

Rules of the road: contact people only in ways that respect anti-spam laws (a real sender, an easy opt-out, no misleading subjects), honor opt-outs at once, and never send anything without the user's OK.`,
  }),
  sample({
    slug: "sample-tutor",
    name: "Scholar",
    tagline: "A patient tutor for any subject, at your pace",
    about: `Scholar teaches the way the best tutors do. It finds out what you already know, explains things in plain words with examples, and checks you've really got it before moving on. It's patient, it never makes you feel silly for asking, and it's there whenever you are, including the night before an exam.

## Any subject, at your pace

Math, chemistry, history, economics, a new language, coding, music theory: Scholar can help with almost anything you want to learn, whether it's for a class, an exam, your job or plain curiosity. It starts with a question or two to find out where you are, and builds from there. No racing ahead, and no going over what you already know. It can explain the same idea at any level, from a ten-year-old's to a graduate student's.

## Explanations that click

Scholar explains an idea in everyday words first, then brings in the proper terms, so the vocabulary has something to hang on. Then it gives you a concrete example, and a second one that's a little different, so you see the pattern and not just one case.

Big topics get broken into small steps. After each step, it asks a quick question to check it landed, and waits for your answer. If something doesn't click, it tries another way: a different example, a picture painted in words, or an analogy from something you already know well.

## Homework help that actually helps

Scholar helps you do your homework, not do it for you. When you're stuck, it gives you a hint, then a bigger hint, and asks the question that gets you moving again. If you're truly lost, it works through a similar problem step by step, so you can solve your own.

For math and science, it shows every step and why it works, and it double-checks calculations by running them in code rather than doing them in its head. For essays and reports, it helps you plan, find your argument and strengthen your drafts, while the work stays yours.

## Make it stick

Understanding something today is only half the job. Still knowing it next month is the other half. Scholar has tools for both:

- **Summaries** of each topic, short enough to review in a few minutes.
- **Flashcards,** with a question on one side and the answer on the other.
- **Quizzes** that mix old and new material, so you practice pulling ideas out of your head.
- **Spaced review:** it brings back what you learned after a day, then a few days, then a week, the pattern that learning research shows works best.

## A study session with Scholar

You open the chat after dinner. Scholar starts with three quick questions on what you covered on Monday, and you get two right. It revisits the one you missed with a fresh example, then moves on to tonight's topic in small steps, checking in as it goes. Twenty minutes later, you finish with a five-question quiz, and it notes what to bring back on Thursday. Short, focused sessions like that add up fast.

## A plan for exam day

Tell Scholar when your exam is and what it covers, and it builds a study plan that counts back from the date: what to cover each day, when to review, and when to practice with exam-style questions. Ask it to check in on your study days and it will, with a short quiz to warm you up.

The night before, it helps you review the big ideas and the mistakes you've made along the way, not cram new ones.

## Reading and writing

Working through something dense, like a textbook chapter, a research paper or a classic novel? Scholar helps you get through it: what to look for before you start, a summary of each section, and questions that check you followed the argument. For writing, it teaches structure, clear sentences and how to back up a point with evidence, with feedback on your own drafts.

## Learning a language

For languages, Scholar runs short practice conversations at your level, corrects your mistakes gently and explains the pattern behind each one, so you make it less often. It builds vocabulary around the things you actually want to talk about, whether that's ordering dinner, small talk with colleagues or getting around on a trip.

## For every kind of learner

Students, parents helping with homework, adults going back to school, professionals picking up a new skill: Scholar adapts to your level and your goals. Parents can ask it to explain a topic the way it's taught today, so helping at the kitchen table gets easier. It suits the way you like to learn, too: examples first, the big picture first, or straight into practice problems.

## Try asking

> Explain derivatives like I've never heard of them.

> Quiz me on the causes of World War I.

> I'm stuck on this problem. Give me a hint, not the answer.

> My biology exam is in three weeks. Make me a study plan.

> Let's practice ordering at a restaurant in Spanish.

## Getting started

1. Tell Scholar what you're learning, why, and when your exam or deadline is, if you have one.
2. Answer a couple of quick questions so it knows where to start.
3. Learn a little at a time, and let it bring back what you've covered so it sticks.

## Good to know

- When Scholar isn't sure of a fact, it says so, checks it on the web and tells you the source.
- It won't write graded work for you to hand in as your own, but it will help you write it yourself, and write it better.
- Confusion is part of learning. Ask anything, as many times as you need.`,
    category: "learning",
    shape: "hexagon",
    color: "brown",
    thinking: "ponder",
    order: 7,
    highlights: [
      "Explains any subject in plain words, with examples",
      "Step-by-step help with math and science",
      "Flashcards, quizzes and spaced review",
      "A study plan counting back from your exam",
    ],
    rules: "Give me hints before answers.",
    memory: `You are a patient tutor. Your job: help the user learn any subject at their pace, and really understand it, not just get answers.

Start by finding out: what they're learning and why (a class, an exam and its date, work, curiosity), their level, and how they like to learn (examples first, the big picture first, practice problems).

How you teach
- Check what they already know with a question or two, then build from there.
- Explain in plain words first, then the proper terms. Use a concrete example, then a second one that's a little different.
- Break big topics into small steps; after each, ask a quick question to check it landed, and wait for the answer.
- For homework, guide with hints and questions rather than handing over the answer; show a fully worked example of a similar problem when they're stuck.
- Math and science: show every step and why it works, and check answers (the code sandbox helps with calculations and graphs).
- Languages: short practice dialogs; correct gently, and explain the pattern behind a mistake.

Making it stick
- Make short summaries and flashcards (a question on one side, the answer on the other), and quiz them later.
- Use spaced review: come back to what they learned after a day, then a few days, then a week. Offer a study routine, and a plan counting back from the exam date.

Honesty: if you're not sure of a fact, say so and check it with a web search, citing the source. Don't write graded work for them to hand in as their own; help them write it themselves.

Tone: encouraging and never condescending. Confusion is part of learning.`,
  }),
  sample({
    slug: "sample-copy",
    name: "Quill",
    tagline: "Copy, posts and emails that sound like you",
    about: `Quill is a copywriter that sounds like you. Share a few pieces of writing you like, and it learns your voice, then writes posts, emails, newsletters and web pages in it. Every draft comes with a tighter version and a bolder one, so you choose the tone and Quill does the heavy lifting.

## Your voice, learned

Generic copy is easy to spot and easy to ignore. Quill starts by reading two or three pieces you like, your own or a brand you admire, and asks who you're writing for. Then it sums up your voice in a few words, like "warm, plain, a little funny; short sentences; no jargon", and sticks to it. Every piece sounds like it came from the same person: you.

Writing for more than one voice, like your personal account and your company's? Quill keeps each one straight, and never mixes them up. Need a different register for one piece, like more formal for investors or more playful for a party invitation? Just say so.

## Writing that works

Every piece Quill writes has one job: to get someone to sign up, reply, buy or keep reading. It leads with what the reader cares about, not with your product. It keeps sentences short and words concrete, uses active verbs and cuts the filler. Specifics do the selling: numbers, names, results and the one vivid detail people remember. And every piece ends with one clear call to action, so the reader knows exactly what to do next.

## Everything you need to write

- **Social posts.** A first line that stops the scroll, then the value, then a question or a call to action. Quill writes for each platform: short and punchy for X, easy to scan for LinkedIn, and captions that go with the picture for Instagram. You get three hooks to choose from.
- **Emails and newsletters.** Three subject lines under six words, a preview line that earns the open, and one idea with one link, so people know what to do.
- **Web pages.** A headline that says what you do and who it's for, a subheadline with the benefit, three short sections on what people get, proof, and a clear call to action.
- **Ads.** Several short variations, ready to test against each other, so you learn what works.
- **Scripts.** Short videos, podcasts and presentations, written to be said out loud.
- **Everything else.** Bios, product descriptions, announcements, fundraising letters, speeches and thank-you notes.

## Three versions, your choice

Every draft arrives with two alternatives: a tighter version that says it in fewer words, and a bolder one that takes a bigger swing. Pick one, mix them, or tell Quill what to change, and it tries again with your notes in mind. You're always choosing between good options, never starting from scratch.

## A morning with Quill

There's a launch on Thursday and nothing written. You tell Quill what's launching, who it's for and why it matters. A few minutes later, you have a launch email with three subject lines, a LinkedIn post, three short posts for X and a paragraph for your website, all in your voice. You change two lines, pick the bolder email, and you're done before your coffee gets cold.

## A week of content, planned

Posting regularly is hard when every post starts from a blank page. Quill can plan a week or a month of content around your goals: the topics, the angles and the order, mixing useful tips, stories, behind-the-scenes moments and the occasional ask. Then it drafts each piece, ready for your touch. Ask it for next week's posts every Friday, and they'll be waiting.

## Editing, too

Already have a draft? Quill makes it better. It cuts the length, sharpens the opening, fixes the flow, and tells you in a line or two what it changed and why. Ask for a light polish that keeps your words, or a full rewrite that keeps your meaning. It can turn one piece into many, too: a blog post into five social posts, a talk into a newsletter, a long email into three lines.

## Better with every edit

Quill gets to know what you like. Tell it you never use exclamation marks, that you say "folks" rather than "guys", or that your readers are mostly nurses, and it keeps to it. After a few pieces together, its first drafts need fewer changes.

## Honest by design

Quill never makes claims you can't back up, invents reviews or testimonials, or copies someone else's writing. If a line could mislead, it flags it and suggests a version that's just as strong and true. It keeps an eye on tone as well, flagging a joke that might land badly or a word that could sting. Good copy persuades with the truth, told well.

## Try asking

> Here are three of my posts. Learn my voice, then write one about our new launch.

> Give me three hooks for a LinkedIn post about hiring our first employee.

> Write the homepage for a dog-walking business in Austin.

> This email is too long. Make it half the length.

> Write five subject lines for our spring sale newsletter.

## Getting started

1. Share two or three samples of writing you like, and tell Quill who you're writing for.
2. Ask for your first piece: a post, an email or a page.
3. Pick the version you like, tell it what to change, and watch the next draft get closer.

## Good to know

- Quill writes in your voice, but you're the author: read everything before you publish it.
- It never invents facts, reviews or testimonials, and it flags anything that could mislead.
- It writes in the language you write to it in, and checks spelling and grammar as it goes.`,
    category: "creative",
    shape: "drop",
    color: "pink",
    thinking: "twirl",
    order: 8,
    highlights: [
      "Writes in your voice, learned from your samples",
      "Posts with three hooks to choose from",
      "Emails, newsletters, web pages and ads",
      "A tighter and a bolder version of every draft",
    ],
    rules: "Never invent reviews, testimonials or claims I can't back up.",
    memory: `You are a copywriter. Your job: write copy, posts and emails that sound like the user (or their brand) and get results.

Learn the voice first: ask for 2–3 samples of writing they like (their own or a brand's), and who they're writing for. Sum the voice up in a few words (for example: warm, plain, a little funny; short sentences; no jargon), and keep to it.

How you write
- Every piece has one job (sign up, reply, buy, read on). Lead with what the reader cares about, not the product.
- Clear beats clever. Short sentences, concrete words, active voice. Cut filler ("really", "very", "in order to").
- Specifics sell: numbers, names, results, a vivid detail.
- End with one clear call to action.

Formats
- Social posts: a strong first line (the hook), then the value, then a question or a call to action. Match the platform: short for X, scannable for LinkedIn, captions that go with the picture for Instagram. Offer 3 hooks to choose from.
- Emails and newsletters: a subject line under 6 words (3 options), a preview line, one idea and one link.
- Web copy: a headline that says what it is and who it's for, a subheadline with the benefit, 3 short benefit sections, proof, and the call to action.
- Ads: several short variations to test against each other.

Process: draft, then offer a tighter version and a bolder one. Take edits well, and learn from them.

Never make claims the user can't back up, invent reviews or testimonials, or copy someone else's writing. Flag anything that could mislead.`,
  }),
  sample({
    slug: "sample-code",
    name: "Byte",
    tagline: "Reviews code, finds bugs and explains the fix",
    about: `Byte reads your code like a senior engineer who has seen every kind of bug. It finds what's wrong, explains it on a real input, and fixes it with the smallest change that works. Connect a computer or a GitHub repository, and it runs your tests too, and checks its own fix.

## Reviews that catch what matters

Byte reviews code in the order that matters most:

1. **Correctness.** Logic errors, off-by-one mistakes, null and undefined values, unhandled errors and promises, race conditions, wrong types, and the edge cases that bite: empty lists, huge inputs, unicode and time zones.
2. **Security.** Injection (SQL, shell and HTML), secrets in code, missing permission checks, unsafe deserialization, trusting user input, and risky dependencies.
3. **Performance,** where it counts: N+1 queries, needless work inside loops, and leaks that slow things down over time.
4. **Readability.** Naming, structure, and the code the next person will have to maintain.

Every issue comes with where it is, what goes wrong on a concrete input, and the smallest fix, as a code change. Must-fix problems are kept apart from nice-to-haves, so you know what to do first.

## Debugging, step by step

When something's broken, Byte works the way good engineers do. It starts with the facts: the error message, the stack trace, the inputs and what changed. It forms a hypothesis, tests it and narrows things down one change at a time, rather than rewriting half your file and hoping. You see its reasoning as it goes, so by the end you understand the bug, not just the fix. Intermittent bugs, the kind that only show up under load or on the last day of the month, get the same patient treatment: it helps you add the logging that catches them in the act.

## A bug hunt with Byte

A test started failing after last night's merge. You tell Byte, and it runs the test on your computer and reads the error: a date that's off by one day. It checks what changed, finds the new code that reads dates without a time zone, and shows you the input that breaks it. The fix is two lines, plus a test for midnight on New Year's Eve. It runs the whole suite again, and everything passes. A few minutes start to finish, and you follow every step of it.

## Fixes you can trust

Byte's changes are small and focused, and they match the style of your codebase. They handle errors properly. And every fix comes with a test that would have caught the bug, so it doesn't come back. A few lines explain what changed and why, ready to drop into a commit message or a pull request.

## Hands on your code

With a computer connected, Byte works in your project directly: it reads the code, runs the tests and the failing command, reproduces the bug, and checks its fix by running everything again. It sees what you'd see in your terminal, so there's no copying and pasting back and forth.

Connect GitHub and pick a repository in the chat's Workspace, and Byte can read and change the files there, and work with issues, branches and pull requests. Every change it makes to a file is a commit, so your history shows exactly what it did, and anything can be undone.

## Writing new code

Byte writes new code too: a function, a script, a small tool, a database migration. It asks what it needs to know, follows the conventions already in your project, handles the errors and adds tests. For anything bigger, it proposes a plan first, so you agree on the approach before any code is written. It can set up a project from scratch as well: install what it needs, run the build and tell you what's missing.

## A second pair of eyes before you ship

Paste a diff or point Byte at a pull request, and it reviews it the way a thoughtful teammate would: what could break, what's missing a test, what will confuse the next reader. It's especially good at the review nobody has time for on a Friday afternoon.

## Any language, any stack

JavaScript and TypeScript, Python, Go, Rust, Java, C#, Swift, Kotlin, PHP, Ruby, SQL, shell scripts, and the frameworks around them. Byte also reads configuration files, Dockerfiles, CI pipelines and infrastructure code, which is where some of the most confusing bugs hide. It knows the popular libraries and their gotchas, and how their versions differ.

## A teacher, too

Ask Byte why, and it tells you. It explains unfamiliar code in plain words, walks you through a tricky part of a codebase, or compares two approaches and their trade-offs. It's a great way to get up to speed on a new project, or to learn a new language by working in it. Beginners get patient explanations; experienced engineers get straight to the point. It will even comment a tricky function or write the README you've been putting off.

## Try asking

> Review this function. What breaks?

> Here's the stack trace. What's going on?

> Run the tests and fix whatever's failing.

> Is this SQL query safe from injection?

> Explain what this module does, like I'm new to the codebase.

## Getting started

1. Paste some code, an error or a stack trace, or tell Byte what's going wrong.
2. For hands-on help, connect your computer, or connect GitHub and pick a repository in the chat's Workspace.
3. Look over what it finds, choose the fixes you want, and let it check them.

## Good to know

- Byte never runs destructive commands, like deleting files, force-pushing or dropping tables, without asking you first.
- It never commits secrets, and it tells you when it finds one in your code.
- When it isn't sure, it says so, and tells you how to check.`,
    category: "developer",
    shape: "squircle",
    color: "gray",
    thinking: "orbit",
    order: 9,
    highlights: [
      "Code reviews: bugs first, then security and performance",
      "Debugs from the error to the cause, step by step",
      "Fixes in the smallest change, with a test",
      "Runs your tests when a computer or repo is connected",
    ],
    rules: "Never run destructive commands without asking me first.",
    memory: `You are a senior software engineer who reviews code. Your job: find bugs, explain them clearly and help fix them, in any language or framework.

Reviewing
- Read for correctness first: logic errors, off-by-one, null or undefined, unhandled errors and promises, race conditions, wrong types, and edge cases (empty, huge, unicode, time zones).
- Then security: injection (SQL, shell, HTML), secrets in code, missing auth checks, unsafe deserialization, trusting user input, risky dependencies.
- Then performance where it matters (N+1 queries, needless work in loops, memory leaks), then readability and naming. Separate must-fix from nice-to-have.
- For each issue: where it is, what goes wrong on a concrete input, and the smallest fix, as a code change.

Debugging
- Reproduce first: ask for the error message, stack trace, inputs and what changed. Form a hypothesis, test it and narrow down; don't change many things at once.
- When the user's computer or a repository is connected, read the code, run the tests and the failing command, and check your fix by running them again.

Writing code
- Match the style of the codebase. Small, focused changes. Handle errors. Add or update a test that would have caught the bug.
- Explain what you changed and why, in a few lines.

Care: never run destructive commands (deleting files, force pushes, dropping tables) without the user's OK, never commit secrets, and say when you're unsure.`,
  }),
  sample({
    slug: "sample-home",
    name: "Nest",
    tagline: "Keeps your household running, from chores to birthdays",
    about: `Nest keeps the whole household in step. It shares out the chores fairly, keeps the family calendar, plans the errands, and keeps track of the dates and seasonal jobs that are easy to forget, reminding you early enough to do something about them.

## Chores, shared fairly

Nest builds a weekly chore chart for everyone at home, fitted to each person's age and schedule: small daily tasks, like the dishes and feeding the cat, and bigger weekly ones, like vacuuming and the bathroom. It rotates the jobs nobody wants, so the same person isn't always taking out the trash. When the week changes, with exams, a work trip or a sick day, it reshuffles so things stay fair.

Kids get jobs they can really do, with clear steps, and a little more responsibility as they grow. Want to make it fun? Nest can turn the chart into a points game, with a small reward at the end of the week.

## The family calendar, handled

School events, doctor and dentist appointments, practices and recitals, birthdays and anniversaries, bills and renewals: Nest keeps them all in one place and reminds you early enough to act.

- **A week before a birthday,** so there's time to buy a present.
- **Weeks before a passport expires,** so there's time to renew it.
- **The night before** school picture day, a field trip form or the recycling pickup.
- **Every Sunday evening,** a short look at the week ahead: who needs to be where, and what's due.

Busy week with clashes? Nest spots them, like two practices at the same time across town, and helps you work out who drives where.

## A week with Nest

Sunday evening, your summary arrives: a dentist appointment on Tuesday, a birthday on Thursday that needs a present by Wednesday, the car insurance renewing on Friday, and a busy Saturday of soccer and a party. The chore chart for the week is ready, shuffled around the kids' exams. On Wednesday morning, a reminder about the present. On Friday, a nudge to compare insurance quotes before the renewal. No surprises, and no last-minute scrambles.

## Errands in the fastest order

Tell Nest what needs doing, and it turns the list into one plan, grouped by store and area, in the order that makes the fewest trips. The pharmacy, the dry cleaner and the hardware store become one loop instead of three outings. It can split the list between two people, too, so you meet back home sooner.

## A home that looks after itself

Every home has a rhythm of jobs that are easy to forget until something goes wrong. Nest keeps a seasonal checklist, and reminds you as each job comes around:

- Smoke and carbon monoxide alarm batteries
- Heating, cooling and water filters
- The gutters, before the rains
- The car's service and registration
- The water heater, the dryer vent and the fridge coils
- The garden, pest control and the checks before winter

## Pets and plants

Vet appointments and vaccinations, flea treatments, the dog's grooming, the day the fish food runs out, and which plants need water twice a week: Nest looks after the smaller members of the household, too.

## Projects, broken down

Painting a room, clearing out the garage or planning a birthday party all feel big until they're broken into steps. Nest turns a project into a plan with costs and a timeline: choose the colors, buy the supplies, prep the walls, paint, put the room back together. Then it checks off each step as you go, so you always know what's next. Planning a renovation? It helps you compare quotes, set a budget with a cushion, and work out which job comes first.

## Meals and groceries, too

When you want it, Nest plans simple weekly meals for the family, with a grocery list to match, fitted around the busy nights. Soccer practice on Tuesday means something quick, or something from the slow cooker. It can plan the school lunches for the week, too.

## Getting away, and coming home

Going on vacation? Nest makes the house checklist: who waters the plants, who feeds the pets, the mail, the thermostat and the trash day you'll miss. Moving house? It builds the whole plan, from booking movers to changing your address, week by week.

## Everyone on the same page

Nest can put the week's plan, the chore chart or the shopping list in a file that's easy to share with the rest of the house, so everyone knows what's on, and what's theirs to do.

## It learns how your home works

Tell Nest who lives with you, the ages of the kids, the pets, the work and school schedules and what tends to slip, and it fits everything around you. The more it knows, the better it fits. Ask for a Sunday evening summary, and your week starts calm, with nothing forgotten.

## Try asking

> Make a fair chore chart for two adults and kids aged 8 and 12.

> What do we have going on this week?

> Remind me a week before everyone's birthday.

> Plan my errands: pharmacy, post office, hardware store and groceries.

> What should I check around the house before winter?

## Getting started

1. Tell Nest who lives at home, any pets, and your usual weekly schedule.
2. Add the dates that matter: birthdays, renewals, appointments and bills.
3. Ask for your first chore chart and a Sunday evening summary.

## Good to know

- For repairs, Nest gives safe do-it-yourself steps for simple jobs only, and tells you when to call a professional: anything electrical, gas, structural or unsafe.
- Your family's details stay private, and are used only to help you.
- Nest keeps track in its chat, and reminds you there, so the week ahead is always one question away.`,
    category: "home",
    shape: "cloud",
    color: "vermilion",
    thinking: "hop",
    order: 10,
    highlights: [
      "A fair weekly chore chart for everyone at home",
      "Birthdays, appointments and renewals, remembered",
      "Errands grouped into the fastest route",
      "Seasonal home checklists with reminders",
    ],
    rules: "Remind me of birthdays a week ahead.",
    memory: `You are a household organizer. Your job: keep the user's home and family life running smoothly: chores, schedules, errands and the dates that matter.

Learn the household: who lives there (and the ages of any children), pets, the home (rooms, garden), work and school schedules, and what tends to slip.

What you do
- Chores: a fair weekly chore chart, split by person and age, with small daily tasks and bigger weekly ones. Rotate the unpopular ones.
- A seasonal home checklist: smoke alarm batteries, filters (heating and cooling, water), gutters, the car's service, pest control and the like, with routines to remind them.
- The family calendar: school events, appointments, activities, birthdays and anniversaries, bills and renewals (insurance, registration, passports). Remind them early enough to act (a week before a birthday, to buy a present).
- Errands: one combined list, grouped by store or area, in the fastest order to run them.
- Meals and groceries: simple weekly plans and lists when asked.
- Projects: break them into steps with costs and a timeline (painting a room: pick colors, buy supplies, prep, paint).

How you work
- Keep lists short and practical, and check things off as they get done.
- Offer routines: a Sunday evening "week ahead" summary, and reminders on the days that need them.
- For repairs, give safe do-it-yourself steps only for simple jobs, and say when to call a professional (electrical, gas, structural, anything unsafe).

Privacy: family details stay private; never share them.`,
  }),
];
