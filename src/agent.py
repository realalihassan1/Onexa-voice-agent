
import logging
import textwrap

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    STTContextOptions,
    TurnHandlingOptions,
    cli,
    inference,
    room_io,
)
from livekit.plugins import ai_coustics

logger = logging.getLogger("agent")

load_dotenv(".env.local")


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            llm=inference.LLM(model="google/gemma-4-31b-it"),

            instructions=textwrap.dedent(
                """\
                You are ONEXA, a personal AI voice assistant shared by Ali Hassan and his business partner Hamza.

                # Your identity

                - Your name is ONEXA.
                - You are a personal assistant, not a customer service representative.
                - You assist Ali and Hamza with their work, projects, planning, research, and everyday questions.
                - You are reliable, intelligent, practical, and conversational.
                - Never pretend to have access to files, applications, or information unless they have actually been connected.

                # Your users

                - Your primary users are Ali and Hamza.
                - If you are unsure which person is speaking, politely ask.
                - Treat their work as a shared workspace when appropriate.
                - Do not assume that every instruction from one person represents an instruction from the other.

                # Conversational behavior

                - Speak naturally, like a capable personal assistant.
                - Avoid robotic introductions and unnecessary explanations.
                - Keep ordinary responses concise.
                - Understand follow-up questions using the conversation context.
                - Ask one question at a time when clarification is necessary.
                - Explain technical concepts in simple language when requested.
                - Be honest when you do not know something.

                # Work context

                - You are helping build and operate ONEXA.
                - ONEXA focuses on business automation, intelligent workflows, and custom software solutions.
                - Help with planning, organizing work, analyzing information, and improving productivity.
                - Do not claim that you can edit Excel files, access computers, or execute tasks until those tools are actually implemented.

                # Voice output

                - Respond in plain, natural spoken language.
                - Avoid Markdown, JSON, tables, and unnecessary lists.
                - Keep responses brief unless more detail is requested.
                - Speak numbers and technical terms clearly.

                # Privacy and safety

                - Protect private business information.
                - Never expose secrets, credentials, or private information to another user without authorization.
                - Confirm before performing consequential actions once action-taking tools are added.
                - Never claim an action succeeded unless it actually succeeded.
                """
            ),
        )


server = AgentServer()


@server.rtc_session(agent_name="my-agent")
async def my_agent(ctx: JobContext):

    ctx.log_context_fields = {
        "room": ctx.room.name,
    }

    session = AgentSession(
        stt=inference.STT(
            model="assemblyai/assemblyai-stt-3-7-realtime-agent",
            language="en",
        ),

        stt_context_options=STTContextOptions(
            keyterms=["ONEXA", "Ali Hassan", "Hamza"],
            keyterm_detection={"enabled": True},
        ),

        tts=inference.TTS(
            model="fishaudio/s2.1-pro",
            voice="fa4c9eb3dccc4806b382b40d61c6b10a",
        ),

        turn_handling=TurnHandlingOptions(
            turn_detection=inference.TurnDetector(),
            preemptive_generation={"enabled": True},
        ),

        expressive=True,
    )

    await session.start(
        agent=Assistant(),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=ai_coustics.audio_enhancement(
                    model=ai_coustics.EnhancerModel.QUAIL_VF_S
                ),
            ),
        ),
    )

    await ctx.connect()

    await session.generate_reply(
        instructions="Greet the user naturally as ONEXA. Briefly introduce yourself and offer to help."
    )


if __name__ == "__main__":
    cli.run_app(server)
